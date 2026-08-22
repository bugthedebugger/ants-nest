import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repository = "bugthedebugger/ants-nest";
const releaseApiUrl = `https://api.github.com/repos/${repository}/releases/latest`;

export type CliUpdateTarget =
  | { mode: "repository"; scriptPath: string; assetName: "ants-nest-cli.cjs" }
  | { mode: "appimage"; appImagePath: string; assetName: "Ants.Nest.AppImage" }
  | { mode: "desktop" }
  | { mode: "npm"; packageName: string };

export type LatestRelease = {
  version: string;
  assets: Record<string, string>;
  checksums?: Record<string, string>;
};

export type CliUpdateResult = {
  updated: boolean;
  currentVersion: string;
  latestVersion: string;
  targetPath?: string;
  reason?: string;
};

export type CliUpdateProgress =
  | { phase: "download"; downloadedBytes: number; totalBytes?: number; complete: boolean }
  | { phase: "verify" | "test" | "install" };

export function normalizeVersion(tag: string) {
  return tag.replace(/^v/i, "");
}

export function compareVersions(left: string, right: string) {
  const parse = (value: string) => {
    const [core = "", suffix] = value.split(/[-+]/);
    return { numbers: core.split(".").map((part) => Number(part) || 0), prerelease: value.includes("-") ? suffix ?? "" : undefined };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const x = a.numbers[index] ?? 0;
    const y = b.numbers[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

export function parseChecksums(text: string) {
  const checksums: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match) checksums[match[2]?.trim() ?? ""] = match[1]?.toLowerCase() ?? "";
  }
  return checksums;
}

export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<LatestRelease> {
  const response = await fetchImpl(releaseApiUrl, { headers: { accept: "application/vnd.github+json", "user-agent": "ants-nest-cli" } });
  if (!response.ok) throw new Error(`Could not check GitHub for the latest release (HTTP ${response.status})`);
  const payload = await response.json() as { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
  const version = normalizeVersion(payload.tag_name ?? "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error("The latest GitHub release did not include a valid version tag");
  const assets: Record<string, string> = {};
  for (const asset of payload.assets ?? []) {
    if (asset.name && asset.browser_download_url) assets[asset.name] = asset.browser_download_url;
  }
  let checksums: Record<string, string> | undefined;
  if (assets["checksums.txt"]) {
    try {
      const checksumResponse = await fetchImpl(assets["checksums.txt"], { headers: { "user-agent": "ants-nest-cli" } });
      if (checksumResponse.ok) checksums = parseChecksums(await checksumResponse.text());
    } catch {
      checksums = undefined;
    }
  }
  return { version, assets, ...(checksums ? { checksums } : {}) };
}

export function resolveCliUpdateTarget(options: { argv1?: string; appImage?: string | null } = {}): CliUpdateTarget {
  const appImage = options.appImage !== undefined ? options.appImage : process.env.APPIMAGE;
  if (appImage) return { mode: "appimage", appImagePath: path.resolve(appImage), assetName: "Ants.Nest.AppImage" };
  const scriptPath = options.argv1 ?? process.argv[1] ?? "";
  if (scriptPath.includes("node_modules")) return { mode: "npm", packageName: "ants-nest" };
  if (!scriptPath) throw new Error("Could not determine which file the ants CLI runs from");
  return { mode: "repository", scriptPath: path.resolve(scriptPath), assetName: "ants-nest-cli.cjs" };
}

async function downloadTo(file: string, url: string, fetchImpl: typeof fetch, onProgress?: (progress: CliUpdateProgress) => void) {
  const response = await fetchImpl(url, { headers: { "user-agent": "ants-nest-cli" }, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Downloading the update failed (HTTP ${response.status})`);
  const contentLength = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
  const reader = response.body.getReader();
  const handle = await fs.open(file, "w", 0o755);
  const hash = createHash("sha256");
  let downloadedBytes = 0;
  onProgress?.({ phase: "download", downloadedBytes, ...(totalBytes ? { totalBytes } : {}), complete: false });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.writeFile(value);
      hash.update(value);
      downloadedBytes += value.byteLength;
      onProgress?.({ phase: "download", downloadedBytes, ...(totalBytes ? { totalBytes } : {}), complete: false });
    }
  } finally {
    await handle.close();
  }
  onProgress?.({ phase: "download", downloadedBytes, ...(totalBytes ? { totalBytes } : {}), complete: true });
  return hash.digest("hex");
}

async function smokeTest(command: string, args: string[], expectedVersion: string) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.FONTCONFIG_FILE;
  const { stdout } = await execFileAsync(command, args, { env: environment, timeout: 60_000, windowsHide: true });
  if (!stdout.includes(expectedVersion)) throw new Error(`The downloaded update reported "${stdout.trim()}" instead of version ${expectedVersion}`);
}

async function swapFile(targetPath: string, updatePath: string) {
  const backupPath = `${targetPath}.bak`;
  await fs.rm(backupPath, { force: true });
  await fs.rename(targetPath, backupPath);
  try {
    await fs.rename(updatePath, targetPath);
  } catch (error) {
    await fs.rename(backupPath, targetPath).catch(() => undefined);
    throw error;
  }
  await fs.rm(backupPath, { force: true }).catch(() => undefined);
}

export async function checkCliUpdate(currentVersion: string, fetchImpl?: typeof fetch): Promise<{ release: LatestRelease; updateAvailable: boolean }> {
  const release = await fetchLatestRelease(fetchImpl);
  return { release, updateAvailable: compareVersions(release.version, currentVersion) > 0 };
}

export async function runCliUpdate(options: { currentVersion: string; force?: boolean; fetchImpl?: typeof fetch; target?: CliUpdateTarget; release?: LatestRelease; onProgress?: (progress: CliUpdateProgress) => void }): Promise<CliUpdateResult> {
  const target = options.target ?? resolveCliUpdateTarget();
  const release = options.release ?? (await checkCliUpdate(options.currentVersion, options.fetchImpl)).release;
  const updateAvailable = compareVersions(release.version, options.currentVersion) > 0;
  if (!updateAvailable && !options.force) {
    return { updated: false, currentVersion: options.currentVersion, latestVersion: release.version, reason: "up-to-date" };
  }
  if (target.mode === "npm") {
    return { updated: false, currentVersion: options.currentVersion, latestVersion: release.version, reason: `This CLI was installed with npm. Run \`npm install -g ${target.packageName}@${release.version}\` to update.` };
  }
  if (target.mode === "desktop") {
    return { updated: false, currentVersion: options.currentVersion, latestVersion: release.version, reason: "This launcher follows the installed desktop app. Update Ants Nest itself first." };
  }
  const downloadUrl = release.assets[target.assetName];
  if (!downloadUrl) throw new Error(`Release v${release.version} does not include ${target.assetName}`);
  const targetPath = target.mode === "appimage" ? target.appImagePath : target.scriptPath;
  const directory = path.dirname(targetPath);
  await fs.access(targetPath).catch(() => { throw new Error(`Could not find the installed file to replace: ${targetPath}`); });
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.update-${process.pid}`);
  try {
    const actualChecksum = await downloadTo(temporaryPath, downloadUrl, options.fetchImpl ?? fetch, options.onProgress);
    const expectedChecksum = release.checksums?.[target.assetName];
    if (expectedChecksum) {
      options.onProgress?.({ phase: "verify" });
      if (actualChecksum !== expectedChecksum.toLowerCase()) throw new Error(`Checksum mismatch for ${target.assetName}: expected ${expectedChecksum}, got ${actualChecksum}`);
    }
    await fs.chmod(temporaryPath, 0o755);
    options.onProgress?.({ phase: "test" });
    if (target.mode === "appimage") await smokeTest(temporaryPath, ["--cli", "--version"], release.version);
    else await smokeTest(process.execPath, [temporaryPath, "--version"], release.version);
    options.onProgress?.({ phase: "install" });
    await swapFile(targetPath, temporaryPath);
    return { updated: true, currentVersion: options.currentVersion, latestVersion: release.version, targetPath };
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
