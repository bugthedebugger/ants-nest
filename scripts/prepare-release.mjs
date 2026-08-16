import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import packageMetadata from "../package.json" with { type: "json" };

const root = process.cwd();
const releaseDirectory = path.join(root, "release");
const appImage = path.join(releaseDirectory, `Ants.Nest-${packageMetadata.version}.AppImage`);
await fs.access(appImage);
await Promise.all([
  fs.copyFile(path.join(root, "dist", "cli", "index.cjs"), path.join(releaseDirectory, "ants-nest-cli.cjs")),
  fs.copyFile(path.join(root, "assets", "icon.png"), path.join(releaseDirectory, "ants-nest-icon.png")),
]);
await Promise.all([
  fs.rm(path.join(releaseDirectory, "linux-unpacked"), { recursive: true, force: true }),
  fs.rm(path.join(releaseDirectory, "builder-debug.yml"), { force: true }),
  fs.rm(path.join(releaseDirectory, "builder-effective-config.yaml"), { force: true }),
  fs.rm(path.join(releaseDirectory, "latest-linux.yml"), { force: true }),
]);
console.log(`Prepared release assets for Ants Nest ${packageMetadata.version}`);
