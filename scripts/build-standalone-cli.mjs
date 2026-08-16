import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import packageMetadata from "../package.json" with { type: "json" };

const outputDirectory = path.resolve("dist", "standalone");
const output = path.join(outputDirectory, "ants-nest-cli.cjs");
await fs.mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [path.resolve("src", "cli", "index.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
});
await fs.chmod(output, 0o755);

// Verify from outside the repository so Node cannot accidentally resolve an
// unbundled dependency from this project's node_modules directory.
const isolatedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ants-nest-standalone-"));
const isolatedCli = path.join(isolatedDirectory, "ants-nest-cli.cjs");
try {
  await fs.copyFile(output, isolatedCli);
  const result = spawnSync(process.execPath, [isolatedCli, "--version"], {
    cwd: isolatedDirectory,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: "" },
  });
  if (result.status !== 0) throw new Error(`Standalone CLI failed in isolation:\n${result.stderr || result.stdout}`);
  if (result.stdout.trim() !== packageMetadata.version) throw new Error(`Standalone CLI reported ${result.stdout.trim()} instead of ${packageMetadata.version}`);
} finally {
  await fs.rm(isolatedDirectory, { recursive: true, force: true });
}
console.log(`Built and isolated-tested standalone CLI ${packageMetadata.version}`);
