import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import packageMetadata from "../package.json" with { type: "json" };

const root = process.cwd();
const releaseDirectory = path.join(root, "release");
const appImage = path.join(releaseDirectory, "Ants.Nest.AppImage");
await fs.access(appImage);
await Promise.all([
  fs.copyFile(path.join(root, "dist", "standalone", "ants-nest-cli.cjs"), path.join(releaseDirectory, "ants-nest-cli.cjs")),
  fs.copyFile(path.join(root, "assets", "icon.png"), path.join(releaseDirectory, "ants-nest-icon.png")),
]);
const checksummedAssets = ["Ants.Nest.AppImage", "ants-nest-cli.cjs"];
const checksums = await Promise.all(checksummedAssets.map(async (name) => {
  const digest = createHash("sha256").update(await fs.readFile(path.join(releaseDirectory, name))).digest("hex");
  return `${digest}  ${name}`;
}));
await fs.writeFile(path.join(releaseDirectory, "checksums.txt"), `${checksums.join("\n")}\n`);
await Promise.all([
  fs.rm(path.join(releaseDirectory, "linux-unpacked"), { recursive: true, force: true }),
  fs.rm(path.join(releaseDirectory, "builder-debug.yml"), { force: true }),
  fs.rm(path.join(releaseDirectory, "builder-effective-config.yaml"), { force: true }),
]);
console.log(`Prepared release assets for Ants Nest ${packageMetadata.version}`);
