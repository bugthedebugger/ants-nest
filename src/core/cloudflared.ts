import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cloudflareDirectory, paths } from "./paths";
import type { DoctorResult } from "../shared/types";
import { readCloudflareConfig } from "./cloudflare-api";

const executable = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";

type GithubAsset = { name: string; browser_download_url: string; digest?: string | null };
type GithubRelease = { tag_name: string; body?: string | null; assets: GithubAsset[] };

function assetForCurrentPlatform() {
  const key = `${process.platform}-${process.arch}`;
  const assets: Record<string, { name: string; archive: boolean }> = {
    "linux-x64": { name: "cloudflared-linux-amd64", archive: false },
    "linux-arm64": { name: "cloudflared-linux-arm64", archive: false },
    "darwin-x64": { name: "cloudflared-darwin-amd64.tgz", archive: true },
    "darwin-arm64": { name: "cloudflared-darwin-arm64.tgz", archive: true },
    "win32-x64": { name: "cloudflared-windows-amd64.exe", archive: false },
  };
  const asset = assets[key];
  if (!asset) throw new Error(`Automatic cloudflared installation is not available for ${key}`);
  return asset;
}

function checksumFromRelease(release: GithubRelease, asset: GithubAsset) {
  const digest = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1];
  if (digest) return digest.toLowerCase();
  const escapedName = asset.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fromNotes = release.body?.match(new RegExp(`${escapedName}:\\s*([a-f0-9]{64})`, "i"))?.[1];
  if (!fromNotes) throw new Error(`Cloudflare did not publish a SHA-256 checksum for ${asset.name}`);
  return fromNotes.toLowerCase();
}

async function sha256(file: string) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function extractArchive(archive: string, destination: string) {
  const extractionDirectory = `${archive}.extract`;
  await fs.mkdir(extractionDirectory, { recursive: true, mode: 0o700 });
  const { execFile } = await import("node:child_process");
  await promisify(execFile)("tar", ["-xzf", archive, "-C", extractionDirectory]);
  const entries = await fs.readdir(extractionDirectory, { recursive: true });
  const binary = entries.find((entry) => path.basename(String(entry)) === "cloudflared");
  if (!binary) throw new Error("The cloudflared archive did not contain a cloudflared binary");
  await fs.copyFile(path.join(extractionDirectory, String(binary)), destination);
  await fs.rm(extractionDirectory, { recursive: true, force: true });
}

let installing: Promise<string> | undefined;

export function installCloudflared(): Promise<string> {
  if (installing) return installing;
  installing = (async () => {
    if (process.env.CLOUDFLARED_BIN) return process.env.CLOUDFLARED_BIN;
    const destination = paths.cloudflaredBinary();
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const platformAsset = assetForCurrentPlatform();
    const releaseResponse = await fetch("https://api.github.com/repos/cloudflare/cloudflared/releases/latest", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "ants-nest" },
    });
    if (!releaseResponse.ok) throw new Error(`Unable to check the latest cloudflared release: HTTP ${releaseResponse.status}`);
    const release = await releaseResponse.json() as GithubRelease;
    const asset = release.assets.find((candidate) => candidate.name === platformAsset.name);
    if (!asset) throw new Error(`Cloudflare release ${release.tag_name} does not include ${platformAsset.name}`);
    const expectedHash = checksumFromRelease(release, asset);
    const metadata = await fs.readFile(paths.cloudflaredMetadata(), "utf8").then(JSON.parse).catch(() => undefined) as { version?: string; sha256?: string } | undefined;
    if (fsSync.existsSync(destination) && metadata?.version === release.tag_name && metadata.sha256 === expectedHash && await sha256(destination) === expectedHash) return destination;

    const temporary = path.join(path.dirname(destination), `${executable}.${randomUUID()}.download`);
    const response = await fetch(asset.browser_download_url, { headers: { "User-Agent": "ants-nest" } });
    if (!response.ok) throw new Error(`Unable to install cloudflared: HTTP ${response.status}`);
    await fs.writeFile(temporary, Buffer.from(await response.arrayBuffer()), { mode: 0o600, flag: "wx" });
    const actualHash = await sha256(temporary);
    if (actualHash !== expectedHash) {
      await fs.rm(temporary, { force: true });
      throw new Error(`The downloaded ${asset.name} failed SHA-256 verification`);
    }
    const stagedBinary = `${destination}.${randomUUID()}.new`;
    if (platformAsset.archive) {
      await extractArchive(temporary, stagedBinary);
      await fs.rm(temporary, { force: true });
    } else {
      await fs.rename(temporary, stagedBinary);
    }
    if (process.platform !== "win32") await fs.chmod(stagedBinary, 0o700);
    await fs.rename(stagedBinary, destination);
    await fs.writeFile(paths.cloudflaredMetadata(), `${JSON.stringify({ version: release.tag_name, sha256: expectedHash, asset: asset.name }, null, 2)}\n`, { mode: 0o600 });
    return destination;
  })().catch((error) => {
    throw error;
  }).finally(() => {
    installing = undefined;
  });
  return installing;
}

export function cloudflaredBinary(): string {
  if (process.env.CLOUDFLARED_BIN) return process.env.CLOUDFLARED_BIN;
  const managedBinary = paths.cloudflaredBinary();
  return fsSync.existsSync(managedBinary) ? managedBinary : executable;
}

export async function run(args: string[], options: { timeoutMs?: number; inherit?: boolean } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cloudflaredBinary(), args, {
      shell: false,
      windowsHide: false,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`cloudflared timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : undefined;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `cloudflared exited with code ${code}`).trim()));
    });
  });
}

export async function doctor(): Promise<DoctorResult> {
  const config = await readCloudflareConfig();
  const result: DoctorResult = {
    installed: false,
    authenticated: Boolean(config),
    configDirectory: cloudflareDirectory(),
    ...(config ? { proxyDomain: config.proxyDomain } : {}),
  };
  try {
    const { stdout, stderr } = await run(["--version"], { timeoutMs: 5000 });
    result.installed = true;
    result.version = (stdout || stderr).trim();
    result.binary = cloudflaredBinary();
  } catch {
    return result;
  }
  return result;
}

export async function spawnTunnel(profileId: string, args: string[]): Promise<{ pid: number; logPath: string }> {
  if (!process.env.CLOUDFLARED_BIN && !fsSync.existsSync(paths.cloudflaredBinary())) {
    throw new Error("cloudflared is not installed. Complete Cloudflare Setup first.");
  }
  await fs.mkdir(paths.logs(), { recursive: true, mode: 0o700 });
  const logPath = path.join(paths.logs(), `${profileId}.log`);
  await fs.writeFile(logPath, "", { mode: 0o600 });
  const output = fsSync.openSync(logPath, "a");
  const child = spawn(cloudflaredBinary(), args, {
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", output, output],
  });
  child.unref();
  fsSync.closeSync(output);
  if (!child.pid) throw new Error("cloudflared did not start");
  return { pid: child.pid, logPath };
}

export function isRunning(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopProcess(pid?: number) {
  if (!pid || !isRunning(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 3000;
  while (isRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (isRunning(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
  }
}

export async function waitUntilReady(logPath: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await fs.readFile(logPath, "utf8").catch(() => "");
    if (/Registered tunnel connection|Connection .* registered/i.test(content)) return;
    const fatal = content.split("\n").find((line) => /ERR|failed to|error parsing/i.test(line));
    if (fatal && /Unable to|failed to|error parsing|credentials file|not found/i.test(fatal)) throw new Error(fatal.trim());
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Timed out waiting for cloudflared to connect. Check the tunnel logs for details.");
}
