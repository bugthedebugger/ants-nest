import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(version) {
  const match = version.match(semverPattern);
  if (!match) throw new Error(`Invalid SemVer version: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function validateManifestVersions(packageMetadata, lockMetadata) {
  const version = packageMetadata?.version;
  if (typeof version !== "string") throw new Error("package.json does not contain a string version");
  parseSemver(version);
  const lockVersion = lockMetadata?.version;
  const rootLockVersion = lockMetadata?.packages?.[""]?.version;
  if (lockVersion !== version || rootLockVersion !== version) {
    throw new Error(`Version mismatch: package.json=${version}, package-lock.json=${String(lockVersion)}, package-lock root=${String(rootLockVersion)}. Run npm install --package-lock-only and commit both files.`);
  }
  return version;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function topLevelFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

function requiredPlatformFiles(platform, version) {
  if (platform === "linux") return ["Ants.Nest.AppImage", "latest-linux.yml"];
  if (platform === "mac") return [`Ants.Nest-${version}-mac-arm64.dmg`, `Ants.Nest-${version}-mac-arm64.zip`, "latest-mac.yml"];
  if (platform === "windows") return [`Ants.Nest-Setup-${version}-win-x64.exe`, "latest.yml"];
  throw new Error(`Unsupported release platform: ${platform}`);
}

function publicBuilderAsset(name, required) {
  return required.includes(name) || required.some((asset) => name === `${asset}.blockmap`);
}

export async function stageReleaseAssets({ platform, root = process.cwd() }) {
  const packageMetadata = await readJson(path.join(root, "package.json"));
  const lockMetadata = await readJson(path.join(root, "package-lock.json"));
  const version = validateManifestVersions(packageMetadata, lockMetadata);
  const source = path.join(root, "release");
  const destination = path.join(root, "artifacts", platform);
  const sourceFiles = await topLevelFiles(source);
  const required = requiredPlatformFiles(platform, version);
  const missing = required.filter((name) => !sourceFiles.includes(name));
  if (missing.length > 0) throw new Error(`Missing ${platform} release assets: ${missing.join(", ")}`);

  const selected = sourceFiles.filter((name) => publicBuilderAsset(name, required));
  if (platform === "linux") selected.push("ants-nest-cli.cjs", "ants-nest-icon.png");
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  for (const name of selected) {
    const from = name === "ants-nest-cli.cjs"
      ? path.join(root, "dist", "standalone", name)
      : name === "ants-nest-icon.png"
        ? path.join(root, "assets", "icon.png")
        : path.join(source, name);
    await fs.copyFile(from, path.join(destination, name));
  }
  return { platform, version, destination, files: selected.sort() };
}

export async function assembleReleaseAssets({ input, output, root = process.cwd() }) {
  const packageMetadata = await readJson(path.join(root, "package.json"));
  const lockMetadata = await readJson(path.join(root, "package-lock.json"));
  const version = validateManifestVersions(packageMetadata, lockMetadata);
  const required = [
    ...requiredPlatformFiles("linux", version),
    ...requiredPlatformFiles("mac", version),
    ...requiredPlatformFiles("windows", version),
    "ants-nest-cli.cjs",
    "ants-nest-icon.png",
  ];
  const inputFiles = await topLevelFiles(input);
  const missing = required.filter((name) => !inputFiles.includes(name));
  if (missing.length > 0) throw new Error(`Missing combined release assets: ${missing.join(", ")}`);
  const unexpected = inputFiles.filter((name) => !publicBuilderAsset(name, required));
  if (unexpected.length > 0) throw new Error(`Unexpected combined release assets: ${unexpected.join(", ")}`);

  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  for (const name of inputFiles) await fs.copyFile(path.join(input, name), path.join(output, name));
  const checksumLines = [];
  for (const name of inputFiles) {
    const digest = createHash("sha256").update(await fs.readFile(path.join(input, name))).digest("hex");
    checksumLines.push(`${digest}  ${name}`);
  }
  await fs.writeFile(path.join(output, "checksums.txt"), `${checksumLines.join("\n")}\n`);
  return { version, output, files: [...inputFiles, "checksums.txt"] };
}
