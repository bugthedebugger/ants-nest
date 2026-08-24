import fs from "node:fs/promises";
import fsSync from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { doctor, installCloudflared, isRunning, spawnTunnel, stopProcess, waitUntilReady } from "./cloudflared";
import { putProfile, readState, updateState, type State } from "./store";
import { desktopFileNamedInputSchema, desktopFileQuickInputSchema, desktopNamedInputSchema, desktopQuickInputSchema, fileNamedInputSchema, fileQuickInputSchema, namedInputSchema, quickInputSchema, type DesktopFileNamedInput, type DesktopFileQuickInput, type DesktopNamedInput, type DesktopQuickInput, type FileNamedInput, type FileQuickInput, type NamedInput, type QuickInput, type TunnelProfile, type TunnelSession, type TunnelView } from "../shared/types";
import { normalizeOrigin, slug, validateHostname } from "../shared/validation";
import { createManagedTunnel, deleteManagedTunnel, saveCloudflareConfig } from "./cloudflare-api";
import type { CloudflareSetupInput } from "../shared/types";
import { parseExpirationTime } from "../shared/duration";
import { paths } from "./paths";

function view(profile: TunnelProfile, session?: TunnelSession): TunnelView {
  const { tokenFile: _tokenFile, shareConfigFile: _shareConfigFile, ...safeProfile } = profile;
  return { ...safeProfile, profileId: profile.id, status: "stopped", ...session };
}

export function isRemoteTunnel(tunnel: Pick<TunnelProfile, "tunnelName">) {
  return tunnel.tunnelName?.startsWith("antsnest-") ?? false;
}

function locate(state: State, idOrName: string) {
  const matches = state.profiles.filter((item) => item.id === idOrName || item.id.startsWith(idOrName) || item.name === idOrName || item.tunnelName === idOrName);
  if (matches.length > 1) throw new Error(`Tunnel reference is ambiguous: ${idOrName}`);
  const profile = matches[0];
  if (!profile) throw new Error(`Tunnel not found: ${idOrName}`);
  const session = state.sessions.find((item) => item.profileId === profile.id);
  return { profile, session };
}

function cleanupFailureMessage(profile: TunnelProfile, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/active connections|stop all cloudflared replicas|connections to close/i.test(detail)) {
    return `Tunnel stopped locally, but Cloudflare still reports active connections after automatic retries. Local access is offline. Make sure no other cloudflared replica is using this tunnel, wait a minute, then run \`ants stop ${profile.id.slice(0, 8)}\` again. Cloudflare said: ${detail}`;
  }
  return `Tunnel stopped locally, but Cloudflare cleanup failed: ${detail}`;
}

async function refreshState() {
  const orphanedPids: number[] = [];
  await updateState((state) => {
    for (const session of state.sessions) {
      const profile = state.profiles.find((item) => item.id === session.profileId);
      const localServerStopped = Boolean(profile?.sharedPath && !isRunning(session.fileServerPid));
      if ((session.status === "online" || session.status === "starting") && (!isRunning(session.pid) || localServerStopped)) {
        if (session.pid) orphanedPids.push(session.pid);
        if (session.fileServerPid) orphanedPids.push(session.fileServerPid);
        session.status = "stopped";
        session.stoppedAt = new Date().toISOString();
        delete session.pid;
        delete session.fileServerPid;
      }
    }
  });
  await Promise.all(orphanedPids.map((pid) => stopProcess(pid)));
}

async function expireOverdueTunnels() {
  const state = await readState();
  const now = Date.now();
  for (const session of state.sessions) {
    if (session.status === "online" && session.expiresAt && new Date(session.expiresAt).getTime() <= now) {
      await expireTunnel(session.profileId, session.expiresAt);
    }
  }
}

type ExpiryWorker = { pid: number; profileId: string; expiresAt: string };

function runningExpiryWorkers(): ExpiryWorker[] {
  if (process.platform !== "linux") return [];
  const workers: ExpiryWorker[] = [];
  for (const entry of fsSync.readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (pid === process.pid) continue;
    try {
      const args = fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      const configuredWorker = process.env.ANTS_NEST_EXPIRY_WORKER;
      const workerIndex = args.findIndex((argument) => argument === configuredWorker || argument.endsWith("/dist/core/expiry-worker.cjs"));
      if (workerIndex < 0 || !args[workerIndex + 1] || !args[workerIndex + 2]) continue;
      const profileId = args[workerIndex + 1]!;
      const expiresAt = args[workerIndex + 2]!;
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(profileId) || !Number.isFinite(new Date(expiresAt).getTime())) continue;
      workers.push({ pid, profileId, expiresAt });
    } catch { /* process exited while /proc was being inspected */ }
  }
  return workers;
}

async function stopExpiryWorkers(profileId: string, expiresAt?: string) {
  const workers = runningExpiryWorkers().filter((worker) => worker.profileId === profileId && (!expiresAt || worker.expiresAt === expiresAt));
  await Promise.all(workers.map((worker) => stopProcess(worker.pid)));
}

function spawnExpiryWorker(profileId: string, expiresAt: string) {
  const workerPath = process.env.ANTS_NEST_EXPIRY_WORKER || path.join(__dirname, "..", "core", "expiry-worker.cjs");
  const child = spawn(process.execPath, [workerPath, profileId, expiresAt], {
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.unref();
  if (!child.pid) throw new Error("Could not start tunnel expiration worker");
  return child.pid;
}

export async function reconcileExpiryWorkers() {
  await expireOverdueTunnels();
  const state = await readState();
  const active = state.sessions.filter((session) => session.status === "online" && session.expiresAt);
  for (const worker of runningExpiryWorkers()) {
    // Every worker is replaced from the current executable. This both removes
    // orphaned jobs and releases mounts belonging to older AppImage versions.
    await stopProcess(worker.pid);
  }
  for (const session of active) {
    const expiryPid = spawnExpiryWorker(session.profileId, session.expiresAt!);
    await updateState((current) => {
      const target = current.sessions.find((item) => item.profileId === session.profileId && item.expiresAt === session.expiresAt);
      if (target) target.expiryPid = expiryPid;
    });
  }
}

export async function listTunnels(): Promise<TunnelView[]> {
  await expireOverdueTunnels();
  await refreshState();
  const state = await readState();
  return state.profiles
    .map((profile) => view(profile, state.sessions.find((item) => item.profileId === profile.id)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createQuick(input: QuickInput): Promise<TunnelView> {
  return createQuickWithHostname(input);
}

function resolveDesktopHostname(value: string, proxyDomain: string) {
  const hostname = validateHostname(value.includes(".") ? value : `${value}.${proxyDomain}`);
  const suffix = `.${proxyDomain}`;
  if (!hostname.endsWith(suffix)) throw new Error(`Desktop hostnames must be under ${proxyDomain}`);
  const label = hostname.slice(0, -suffix.length);
  if (!label || label.includes(".")) throw new Error(`Use a first-level hostname such as preview.${proxyDomain}`);
  return hostname;
}

export async function createDesktopQuick(input: DesktopQuickInput): Promise<TunnelView> {
  const parsed = desktopQuickInputSchema.parse(input);
  return createQuickWithHostname(parsed, "desktop", parsed.hostname);
}

async function availablePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("Could not allocate a local port for the file share");
  return port;
}

function spawnFileServer(configFile: string) {
  const override = process.env.ANTS_NEST_FILE_SHARE_WORKER;
  const cliEntry = process.argv[1];
  const isBundledCli = Boolean(cliEntry && /(?:cli[\\/]index|(?:ants-nest-)?cli)\.cjs$/i.test(cliEntry));
  const workerPath = override || path.join(__dirname, "..", "core", "file-share-worker.cjs");
  const child = isBundledCli && !override
    ? spawn(process.execPath, [cliEntry!], { detached: true, shell: false, windowsHide: true, stdio: "ignore", env: { ...process.env, ANTS_NEST_FILE_SHARE_WORKER_CONFIG: configFile } })
    : spawn(process.execPath, [workerPath, configFile], { detached: true, shell: false, windowsHide: true, stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  child.unref();
  if (!child.pid) throw new Error("Could not start the Ants Nest file server");
  return child.pid;
}

async function waitForLocalServer(port: number, pid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) throw new Error("The Ants Nest file server exited before it was ready");
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(150);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error("Timed out waiting for the Ants Nest file server");
}

async function writeShareConfig(id: string, sharedPath: string, port: number, tokenRequired: boolean) {
  await fs.mkdir(paths.shares(), { recursive: true, mode: 0o700 });
  const configFile = path.join(paths.shares(), `${id}.json`);
  const token = tokenRequired ? randomBytes(24).toString("base64url") : undefined;
  await fs.writeFile(configFile, `${JSON.stringify({ path: sharedPath, port, ...(token ? { token } : {}) })}\n`, { mode: 0o600, flag: "wx" });
  return { configFile, token };
}

async function createFileTunnel(input: FileQuickInput | FileNamedInput, kind: "quick" | "named", hostnameMode: "quickshare" | "desktop", requestedHostname?: string) {
  const parsed = kind === "quick" ? fileQuickInputSchema.parse(input) : fileNamedInputSchema.parse(input);
  const status = await doctor();
  if (!status.installed) throw new Error("cloudflared is not installed");
  if (!status.authenticated || !status.proxyDomain) throw new Error("Complete Cloudflare Setup before creating a share");
  const sharedPath = await fs.realpath(path.resolve(parsed.path)).catch(() => { throw new Error(`File or folder does not exist: ${parsed.path}`); });
  const fileStat = await fs.stat(sharedPath);
  if (!fileStat.isFile() && !fileStat.isDirectory()) throw new Error("Share path must be a regular file or directory");
  const id = randomUUID();
  const label = slug(parsed.name);
  const hostname = hostnameMode === "desktop" ? resolveDesktopHostname(requestedHostname || "", status.proxyDomain) : `${label}-${kind === "quick" ? "quick" : "share"}.${status.proxyDomain}`;
  const tunnelName = `${kind === "quick" ? "quick" : "share"}-${label}-${id.slice(0, 8)}`;
  const port = await availablePort();
  const { configFile } = await writeShareConfig(id, sharedPath, port, parsed.tokenRequired);
  const fileServerPid = spawnFileServer(configFile);
  let persisted = false;
  try {
    await waitForLocalServer(port, fileServerPid);
    const origin = `http://127.0.0.1:${port}`;
    const managed = await createManagedTunnel({ id, name: tunnelName, hostname, origin });
    const profile: TunnelProfile = {
      id, name: parsed.name, description: parsed.description, kind, origin, hostname, tunnelName,
      tunnelId: managed.tunnelId, dnsRecordId: managed.dnsRecordId, tokenFile: managed.tokenFile,
      sharedPath, shareConfigFile: configFile, tokenRequired: parsed.tokenRequired, localServerPort: port, createdAt: new Date().toISOString(),
    };
    if (parsed.expiresInSeconds) profile.expiresInSeconds = parsed.expiresInSeconds;
    if (parsed.expiresAt) profile.fixedExpiresAt = parseExpirationTime(parsed.expiresAt);
    await updateState((state) => putProfile(state, profile, { profileId: id, status: "stopped", fileServerPid }));
    persisted = true;
    return await startTunnel(id);
  } catch (error) {
    if (!persisted) {
      await stopProcess(fileServerPid);
      await fs.rm(configFile, { force: true });
    }
    throw error;
  }
}

export function createFileQuick(input: FileQuickInput) { return createFileTunnel(input, "quick", "quickshare"); }
export function createFileNamed(input: FileNamedInput) { return createFileTunnel(input, "named", "quickshare"); }
export function createDesktopFileQuick(input: DesktopFileQuickInput) {
  const parsed = desktopFileQuickInputSchema.parse(input);
  return createFileTunnel(parsed, "quick", "desktop", parsed.hostname);
}
export function createDesktopFileNamed(input: DesktopFileNamedInput) {
  const parsed = desktopFileNamedInputSchema.parse(input);
  return createFileTunnel(parsed, "named", "desktop", parsed.hostname);
}

export async function createQuickWithHostname(input: QuickInput, hostnameMode: "quickshare" | "remote" | "desktop" = "quickshare", requestedHostname?: string): Promise<TunnelView> {
  // Agent and desktop quick shares must expire. Remote access is a durable,
  // reserved system route whose authorization is controlled per device.
  const parsed = hostnameMode === "remote" ? namedInputSchema.parse(input) : quickInputSchema.parse(input);
  const status = await doctor();
  if (!status.installed) throw new Error("cloudflared is not installed");
  if (!status.authenticated || !status.proxyDomain) throw new Error("Complete Cloudflare Setup before creating a share");
  const id = randomUUID();
  const label = hostnameMode === "remote" ? "antsnest" : slug(parsed.name);
  const hostname = hostnameMode === "remote" ? `${label}.${status.proxyDomain}` : hostnameMode === "desktop" ? resolveDesktopHostname(requestedHostname || "", status.proxyDomain) : `${label}-quick.${status.proxyDomain}`;
  const tunnelName = `${hostnameMode === "remote" ? "antsnest" : `quick-${label}`}-${id.slice(0, 8)}`;
  const origin = normalizeOrigin(parsed.origin);
  const managed = await createManagedTunnel({ id, name: tunnelName, hostname, origin });
  const profile: TunnelProfile = {
    id, name: parsed.name, description: parsed.description, kind: "quick", origin, hostname, tunnelName,
    tunnelId: managed.tunnelId, dnsRecordId: managed.dnsRecordId, tokenFile: managed.tokenFile, createdAt: new Date().toISOString(),
  };
  if (parsed.expiresInSeconds) profile.expiresInSeconds = parsed.expiresInSeconds;
  if (parsed.expiresAt) profile.fixedExpiresAt = parseExpirationTime(parsed.expiresAt);
  await updateState((state) => putProfile(state, profile, { profileId: profile.id, status: "stopped" }));
  return startTunnel(profile.id);
}

export async function createNamed(input: NamedInput): Promise<TunnelView> {
  const parsed = namedInputSchema.parse(input);
  return createNamedWithHostname(parsed);
}

export async function createDesktopNamed(input: DesktopNamedInput): Promise<TunnelView> {
  const parsed = desktopNamedInputSchema.parse(input);
  return createNamedWithHostname(parsed, parsed.hostname);
}

async function createNamedWithHostname(parsed: NamedInput, requestedHostname?: string): Promise<TunnelView> {
  const status = await doctor();
  if (!status.installed) throw new Error("cloudflared is not installed");
  if (!status.authenticated || !status.proxyDomain) throw new Error("Run `ants-nest setup` once before creating a named tunnel");
  const id = randomUUID();
  const label = slug(parsed.name);
  const tunnelName = `share-${label}-${id.slice(0, 8)}`;
  const hostname = requestedHostname ? resolveDesktopHostname(requestedHostname, status.proxyDomain) : validateHostname(`${label}-share.${status.proxyDomain}`);
  const origin = normalizeOrigin(parsed.origin);
  const managed = await createManagedTunnel({ id, name: tunnelName, hostname, origin });
  const profile: TunnelProfile = {
    id, name: parsed.name, description: parsed.description, kind: "named", origin, hostname, tunnelName, tunnelId: managed.tunnelId, dnsRecordId: managed.dnsRecordId, tokenFile: managed.tokenFile, createdAt: new Date().toISOString(),
  };
  if (parsed.expiresInSeconds) profile.expiresInSeconds = parsed.expiresInSeconds;
  if (parsed.expiresAt) profile.fixedExpiresAt = parseExpirationTime(parsed.expiresAt);
  await updateState((state) => putProfile(state, profile, { profileId: profile.id, status: "stopped", publicUrl: `https://${hostname}` }));
  return startTunnel(profile.id);
}

export async function startTunnel(idOrName: string): Promise<TunnelView> {
  await refreshState();
  const state = await readState();
  const { profile, session } = locate(state, idOrName);
  if (session?.status === "online" && isRunning(session.pid)) return view(profile, session);
  if (!profile.tokenFile) throw new Error("This tunnel does not have a managed connector token. Remove and recreate it after Cloudflare Setup.");
  let fileServerPid = session?.fileServerPid;
  if (profile.sharedPath) {
    if (!profile.shareConfigFile || !profile.localServerPort) throw new Error("This file share is missing its local server configuration. Remove and recreate it.");
    if (!isRunning(fileServerPid)) {
      fileServerPid = spawnFileServer(profile.shareConfigFile);
      try { await waitForLocalServer(profile.localServerPort, fileServerPid); }
      catch (error) { await stopProcess(fileServerPid); throw error; }
    }
  }
  const args = ["tunnel", "--no-autoupdate", "run", "--token-file", profile.tokenFile];
  const processInfo = await spawnTunnel(profile.id, args).catch(async (error) => {
    if (fileServerPid) await stopProcess(fileServerPid);
    throw error;
  });
  let starting: TunnelSession;
  try {
    starting = { profileId: profile.id, status: "starting", pid: processInfo.pid, logPath: processInfo.logPath, startedAt: new Date().toISOString(), ...(fileServerPid ? { fileServerPid } : {}) };
    if (profile.expiresInSeconds) starting.expiresAt = new Date(Date.now() + profile.expiresInSeconds * 1000).toISOString();
    if (profile.fixedExpiresAt) starting.expiresAt = parseExpirationTime(profile.fixedExpiresAt);
    if (profile.hostname) {
      const baseUrl = `https://${profile.hostname}`;
      starting.baseUrl = baseUrl;
      if (profile.sharedPath && profile.tokenRequired && profile.shareConfigFile) {
        const config = JSON.parse(await fs.readFile(profile.shareConfigFile, "utf8")) as { token?: string };
        if (!config.token) throw new Error("This protected file share is missing its access token");
        starting.publicUrl = `${baseUrl}/#token=${encodeURIComponent(config.token)}`;
      } else starting.publicUrl = baseUrl;
    }
    await updateState((current) => {
      current.sessions = current.sessions.filter((item) => item.profileId !== profile.id);
      current.sessions.push(starting);
    });
  } catch (error) {
    await stopProcess(processInfo.pid);
    if (fileServerPid) await stopProcess(fileServerPid);
    throw error;
  }
  try {
    await waitUntilReady(processInfo.logPath);
    const online = await updateState((current) => {
      const target = current.sessions.find((item) => item.profileId === profile.id)!;
      target.status = "online";
      return { ...target };
    });
    if (online.expiresAt) {
      await stopExpiryWorkers(profile.id);
      const expiryPid = spawnExpiryWorker(profile.id, online.expiresAt);
      await updateState((current) => {
        const target = current.sessions.find((item) => item.profileId === profile.id);
        if (target) target.expiryPid = expiryPid;
      });
      online.expiryPid = expiryPid;
    }
    return view(profile, online);
  } catch (error) {
    await stopProcess(processInfo.pid);
    if (fileServerPid) await stopProcess(fileServerPid);
    const message = error instanceof Error ? error.message : String(error);
    await updateState((current) => {
      const target = current.sessions.find((item) => item.profileId === profile.id)!;
      target.status = "failed";
      target.error = message;
      delete target.pid;
      delete target.fileServerPid;
    });
    throw new Error(message);
  }
}

export async function stopTunnel(idOrName: string): Promise<TunnelView> {
  const state = await readState();
  const { profile, session } = locate(state, idOrName);
  await stopProcess(session?.pid);
  await stopProcess(session?.fileServerPid);
  await stopExpiryWorkers(profile.id);
  if (profile.tunnelId || profile.hostname) {
    if (!profile.tunnelId || !profile.hostname) throw new Error("Named tunnel metadata is incomplete; refusing unsafe Cloudflare cleanup.");
    try {
      await deleteManagedTunnel({ tunnelId: profile.tunnelId, hostname: profile.hostname, dnsRecordId: profile.dnsRecordId });
    } catch (error) {
      const message = cleanupFailureMessage(profile, error);
      await updateState((current) => {
        const target = current.sessions.find((item) => item.profileId === profile.id);
        if (target) { target.status = "failed"; target.error = message; delete target.pid; delete target.fileServerPid; }
      });
      throw new Error(message);
    }
    await updateState((current) => {
      current.profiles = current.profiles.filter((item) => item.id !== profile.id);
      current.sessions = current.sessions.filter((item) => item.profileId !== profile.id);
    });
    await Promise.all([profile.tokenFile, profile.shareConfigFile].filter(Boolean).map((file) => fs.rm(file!, { force: true }).catch(() => undefined)));
    return view(profile, { profileId: profile.id, status: "stopped", stoppedAt: new Date().toISOString(), publicUrl: session?.publicUrl });
  }
  const stopped = await updateState((current) => {
    const target = current.sessions.find((item) => item.profileId === profile.id) || { profileId: profile.id, status: "stopped" as const };
    target.status = "stopped";
    target.stoppedAt = new Date().toISOString();
    delete target.pid;
    delete target.expiresAt;
    if (!current.sessions.includes(target)) current.sessions.push(target);
    return { ...target };
  });
  return view(profile, stopped);
}

export async function pauseTunnel(idOrName: string): Promise<TunnelView> {
  const state = await readState();
  const { profile, session } = locate(state, idOrName);
  await stopProcess(session?.pid);
  await stopProcess(session?.fileServerPid);
  await stopExpiryWorkers(profile.id);
  const stopped = await updateState((current) => {
    const target = current.sessions.find((item) => item.profileId === profile.id) || { profileId: profile.id, status: "stopped" as const };
    target.status = "stopped";
    target.stoppedAt = new Date().toISOString();
    delete target.pid;
    delete target.fileServerPid;
    delete target.expiryPid;
    delete target.expiresAt;
    delete target.error;
    if (!current.sessions.includes(target)) current.sessions.push(target);
    return { ...target };
  });
  return view(profile, stopped);
}

export async function findRemoteTunnel(): Promise<TunnelView | undefined> {
  return (await listTunnels()).find(isRemoteTunnel);
}

export async function resumeRemoteTunnel(id: string): Promise<TunnelView> {
  await updateState((state) => {
    const { profile, session } = locate(state, id);
    delete profile.expiresInSeconds;
    delete profile.fixedExpiresAt;
    if (session) delete session.expiresAt;
  });
  return startTunnel(id);
}

export async function expireTunnel(idOrName: string, expectedExpiresAt: string): Promise<boolean> {
  let pid: number | undefined;
  let fileServerPid: number | undefined;
  let profile: TunnelProfile | undefined;
  const claimed = await updateState((state) => {
    const located = locate(state, idOrName);
    const session = located.session;
    if (!session || session.status !== "online" || session.expiresAt !== expectedExpiresAt) return false;
    profile = located.profile;
    pid = session.pid;
    fileServerPid = session.fileServerPid;
    session.status = "stopped";
    session.stoppedAt = new Date().toISOString();
    delete session.pid;
    delete session.fileServerPid;
    delete session.expiryPid;
    delete session.expiresAt;
    return true;
  });
  if (claimed) {
    await stopExpiryWorkers(profile!.id, expectedExpiresAt);
    await stopProcess(pid);
    await stopProcess(fileServerPid);
    if (profile?.tunnelId || profile?.hostname) {
      if (!profile.tunnelId || !profile.hostname) throw new Error("Named tunnel metadata is incomplete; refusing unsafe Cloudflare cleanup.");
      try {
        await deleteManagedTunnel({ tunnelId: profile.tunnelId, hostname: profile.hostname, dnsRecordId: profile.dnsRecordId });
        await updateState((state) => {
          state.profiles = state.profiles.filter((item) => item.id !== profile!.id);
          state.sessions = state.sessions.filter((item) => item.profileId !== profile!.id);
        });
        await Promise.all([profile.tokenFile, profile.shareConfigFile].filter(Boolean).map((file) => fs.rm(file!, { force: true }).catch(() => undefined)));
      } catch (error) {
        const message = `Tunnel expired locally, but Cloudflare cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
        await updateState((state) => {
          const session = state.sessions.find((item) => item.profileId === profile!.id);
          if (session) { session.status = "failed"; session.error = message; }
        });
        throw new Error(message);
      }
    }
  }
  return claimed;
}

export async function removeTunnel(idOrName: string): Promise<void> {
  const state = await readState();
  const { profile, session } = locate(state, idOrName);
  await stopProcess(session?.pid);
  await stopProcess(session?.fileServerPid);
  await stopExpiryWorkers(profile.id);
  if (profile.tunnelId || profile.hostname) {
    if (!profile.tunnelId || !profile.hostname) throw new Error("Named tunnel metadata is incomplete; refusing unsafe Cloudflare cleanup.");
    await deleteManagedTunnel({ tunnelId: profile.tunnelId, hostname: profile.hostname, dnsRecordId: profile.dnsRecordId });
  }
  await updateState((current) => {
    current.profiles = current.profiles.filter((item) => item.id !== profile.id);
    current.sessions = current.sessions.filter((item) => item.profileId !== profile.id);
  });
  await Promise.all([profile.tokenFile, profile.shareConfigFile].filter(Boolean).map((file) => fs.rm(file!, { force: true }).catch(() => undefined)));
}

export async function tunnelLogs(idOrName: string): Promise<string> {
  const state = await readState();
  const { session } = locate(state, idOrName);
  if (!session?.logPath) return "No logs yet.";
  const content = await fs.readFile(session.logPath, "utf8").catch(() => "No logs yet.");
  return content.split("\n").slice(-250).join("\n");
}

export async function configureCloudflare(input: CloudflareSetupInput) {
  await saveCloudflareConfig(input);
  await installCloudflared();
  return doctor();
}

export { doctor };
