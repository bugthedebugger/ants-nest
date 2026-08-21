import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopFileQuick, createDesktopQuick, createQuickWithHostname, findRemoteTunnel, listTunnels, pauseTunnel, resumeRemoteTunnel, startTunnel, stopTunnel } from "./manager";
import { remotePage } from "./remote-page";
import { readCloudflareConfig } from "./cloudflare-api";
import { clearRemoteDevices, deleteRemoteDevice, readRemotePersistence, saveRemoteDevice, setRemoteEnabled, updateRemoteDeviceLastSeen } from "./store";
import type { RemoteAccessState, RemoteDevice } from "../shared/types";

type DeviceRecord = RemoteDevice & { tokenHash: Buffer; persistedLastSeenAt: string };
type ActiveRemote = {
  server: http.Server;
  tunnelId: string;
  localUrl: string;
  publicUrl: string;
  startedAt: string;
  proxyDomain: string;
  pairingTokenHash?: Buffer;
  pairingUrl?: string;
  devices: Map<string, DeviceRecord>;
};
let active: ActiveRemote | undefined;

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}

function tokenFrom(request: IncomingMessage, scheme: "Bearer" | "Pairing") {
  return request.headers.authorization?.match(new RegExp(`^${scheme} (.+)$`))?.[1];
}

function matchesToken(token: string | undefined, expected: Buffer | undefined) {
  if (!token || !expected) return false;
  const supplied = createHash("sha256").update(token).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function authorizedDevice(request: IncomingMessage, runtime: ActiveRemote): DeviceRecord | undefined {
  const token = tokenFrom(request, "Bearer");
  if (!token) return undefined;
  const supplied = createHash("sha256").update(token).digest();
  for (const device of runtime.devices.values()) {
    if (supplied.length === device.tokenHash.length && timingSafeEqual(supplied, device.tokenHash)) {
      const now = new Date().toISOString();
      device.lastSeenAt = now;
      if (Date.now() - new Date(device.persistedLastSeenAt).getTime() > 60_000) {
        device.persistedLastSeenAt = now;
        void updateRemoteDeviceLastSeen(device.id, now).catch(() => undefined);
      }
      return device;
    }
  }
  return undefined;
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function cleanDeviceName(value: unknown) {
  if (typeof value !== "string") return "Mobile browser";
  return value.trim().replace(/[\r\n\t]/g, " ").slice(0, 80) || "Mobile browser";
}

async function browsablePath(value: string | null) {
  let requested = value?.trim();
  if (!requested) {
    const documents = path.join(os.homedir(), "Documents");
    requested = await fs.stat(documents).then((stat) => stat.isDirectory() ? documents : os.homedir()).catch(() => os.homedir());
  }
  let resolved = await fs.realpath(path.resolve(requested));
  const selected = await fs.stat(resolved);
  if (!selected.isDirectory()) resolved = path.dirname(resolved);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  return {
    path: resolved,
    parent: path.dirname(resolved),
    entries: entries
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name), kind: entry.isDirectory() ? "folder" as const : "file" as const }))
      .sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1)
      .slice(0, 500),
  };
}

function createRemoteServer(runtime: ActiveRemote) {
  return http.createServer(async (request, response) => {
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    try {
      const url = new URL(request.url || "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/") {
        const nonce = randomBytes(18).toString("base64url");
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
          "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
        });
        return response.end(remotePage(nonce, runtime.proxyDomain));
      }
      if (request.method === "POST" && url.pathname === "/api/auth/pair") {
        const pairingToken = tokenFrom(request, "Pairing");
        if (!matchesToken(pairingToken, runtime.pairingTokenHash)) return json(response, 401, { error: "This pairing code is invalid or has already been used" });
        delete runtime.pairingTokenHash;
        delete runtime.pairingUrl;
        const input = await body(request);
        const token = randomBytes(32).toString("base64url");
        const now = new Date().toISOString();
        const device: DeviceRecord = {
          id: randomUUID(), name: cleanDeviceName(input.name), createdAt: now, lastSeenAt: now,
          tokenHash: createHash("sha256").update(token).digest(),
          persistedLastSeenAt: now,
        };
        runtime.devices.set(device.id, device);
        await saveRemoteDevice(publicDevice(device), device.tokenHash);
        return json(response, 201, { token, device: publicDevice(device) });
      }
      if (!url.pathname.startsWith("/api/") || !authorizedDevice(request, runtime)) return json(response, 401, { error: "This device is not authorized. Scan a new pairing code." });
      if (request.method === "GET" && url.pathname === "/api/tunnels") {
        const tunnels = await listTunnels();
        return json(response, 200, tunnels.filter((tunnel) => tunnel.id !== runtime.tunnelId));
      }
      if (request.method === "GET" && url.pathname === "/api/files") return json(response, 200, await browsablePath(url.searchParams.get("path")));
      if (request.method === "POST" && url.pathname === "/api/tunnels/quick") return json(response, 201, await createDesktopQuick(await body(request)));
      if (request.method === "POST" && url.pathname === "/api/tunnels/quick-file") return json(response, 201, await createDesktopFileQuick(await body(request)));
      const match = url.pathname.match(/^\/api\/tunnels\/([^/]+)\/(start|stop)$/);
      if (request.method === "POST" && match?.[1] && match[2]) {
        const tunnel = match[2] === "start" ? await startTunnel(decodeURIComponent(match[1])) : await stopTunnel(decodeURIComponent(match[1]));
        return json(response, 200, tunnel);
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function publicDevice(device: RemoteDevice): RemoteDevice {
  return { id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt };
}

function snapshot(runtime = active): RemoteAccessState {
  if (!runtime) return { enabled: false, devices: [] };
  return {
    enabled: true,
    localUrl: runtime.localUrl,
    publicUrl: runtime.publicUrl,
    startedAt: runtime.startedAt,
    devices: [...runtime.devices.values()].map(publicDevice).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
    ...(runtime.pairingUrl ? { pairingUrl: runtime.pairingUrl } : {}),
  };
}

export function remoteStatus(): RemoteAccessState {
  return snapshot();
}

export function remoteTunnelId(): string | undefined {
  return active?.tunnelId;
}

export function newRemotePairing(): RemoteAccessState {
  if (!active) throw new Error("Enable remote access before creating a pairing code");
  const token = randomBytes(32).toString("base64url");
  active.pairingTokenHash = createHash("sha256").update(token).digest();
  active.pairingUrl = `${active.publicUrl}/#pair=${token}`;
  return snapshot(active);
}

export async function revokeRemoteDevice(id: string): Promise<RemoteAccessState> {
  if (!active) throw new Error("Remote access is not enabled");
  if (!active.devices.delete(id)) throw new Error("Authorized device not found");
  await deleteRemoteDevice(id);
  // Revocation also invalidates any unclaimed QR so the removed device cannot
  // use a previously copied pairing link to immediately authorize itself again.
  delete active.pairingTokenHash;
  delete active.pairingUrl;
  return snapshot(active);
}

export async function revokeAllRemoteDevices(): Promise<RemoteAccessState> {
  if (!active) throw new Error("Remote access is not enabled");
  active.devices.clear();
  await clearRemoteDevices();
  delete active.pairingTokenHash;
  delete active.pairingUrl;
  return snapshot(active);
}

export async function startRemoteAccess(): Promise<RemoteAccessState> {
  if (active) return snapshot(active);
  const config = await readCloudflareConfig();
  if (!config) throw new Error("Complete Cloudflare Setup before enabling Remote access");
  const persisted = await readRemotePersistence();
  const reusableTunnel = await findRemoteTunnel();
  let listenPort = 0;
  if (reusableTunnel) {
    const savedOrigin = new URL(reusableTunnel.origin);
    if (savedOrigin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(savedOrigin.hostname) || !savedOrigin.port) {
      throw new Error("The saved Remote access tunnel has an invalid local origin");
    }
    listenPort = Number(savedOrigin.port);
  }
  const runtime: ActiveRemote = {
    server: undefined as unknown as http.Server,
    tunnelId: "",
    localUrl: "",
    publicUrl: "",
    startedAt: new Date().toISOString(),
    proxyDomain: config.proxyDomain,
    devices: new Map(persisted.devices.map((device) => [device.id, { ...device, persistedLastSeenAt: device.lastSeenAt }])),
  };
  const server = createRemoteServer(runtime);
  runtime.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine the remote control port");
  runtime.localUrl = `http://127.0.0.1:${address.port}`;
  let createdTunnelId: string | undefined;
  try {
    const tunnel = reusableTunnel
      ? await resumeRemoteTunnel(reusableTunnel.id)
      : await createQuickWithHostname({ name: "Remote access", description: "Secure remote dashboard for controlling Ants Nest from authorized devices", origin: runtime.localUrl }, "remote");
    if (!tunnel.publicUrl) throw new Error("Cloudflare did not return a remote control URL");
    if (!reusableTunnel) createdTunnelId = tunnel.id;
    runtime.tunnelId = tunnel.id;
    runtime.publicUrl = tunnel.publicUrl;
    active = runtime;
    await setRemoteEnabled(true);
    return runtime.devices.size ? snapshot(runtime) : newRemotePairing();
  } catch (error) {
    if (createdTunnelId) await stopTunnel(createdTunnelId).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}

export async function stopRemoteAccess(): Promise<RemoteAccessState> {
  const current = active;
  if (!current) return { enabled: false, devices: [] };
  active = undefined;
  current.devices.clear();
  delete current.pairingTokenHash;
  await setRemoteEnabled(false);
  await clearRemoteDevices();
  await stopTunnel(current.tunnelId).catch(() => undefined);
  await new Promise<void>((resolve) => current.server.close(() => resolve()));
  return { enabled: false, devices: [] };
}

export async function shutdownRemoteAccess(): Promise<void> {
  const current = active;
  if (!current) return;
  active = undefined;
  delete current.pairingTokenHash;
  delete current.pairingUrl;
  await pauseTunnel(current.tunnelId).catch(() => undefined);
  await new Promise<void>((resolve) => current.server.close(() => resolve()));
}

export async function restoreRemoteAccess(): Promise<RemoteAccessState> {
  const persisted = await readRemotePersistence();
  const reusableTunnel = await findRemoteTunnel();
  return persisted.enabled || reusableTunnel ? startRemoteAccess() : { enabled: false, devices: persisted.devices.map(publicDevice) };
}
