import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assembleReleaseAssets, compareSemver, stageReleaseAssets, validateManifestVersions } from "./release-tools.mjs";

test("compares stable and prerelease SemVer values", () => {
  assert.equal(compareSemver("1.2.3", "1.2.2"), 1);
  assert.equal(compareSemver("1.2.3-beta.2", "1.2.3-beta.11"), -1);
  assert.equal(compareSemver("1.2.3", "1.2.3-rc.1"), 1);
  assert.equal(compareSemver("1.2.3+build.2", "1.2.3+build.1"), 0);
});

test("requires package and lockfile versions to agree", () => {
  assert.equal(validateManifestVersions({ version: "2.0.0" }, { version: "2.0.0", packages: { "": { version: "2.0.0" } } }), "2.0.0");
  assert.throws(
    () => validateManifestVersions({ version: "2.0.0" }, { version: "1.0.0", packages: { "": { version: "1.0.0" } } }),
    /Version mismatch/,
  );
});

test("stages an allowlisted Linux release and assembles all platforms", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ants-release-tools-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const version = "3.4.5";
  await fs.mkdir(path.join(root, "release"), { recursive: true });
  await fs.mkdir(path.join(root, "dist", "standalone"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
  await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify({ version, packages: { "": { version } } }));
  for (const name of ["Ants.Nest.AppImage", "latest-linux.yml", "Ants.Nest.AppImage.blockmap", "builder-debug.yml"]) {
    await fs.writeFile(path.join(root, "release", name), name);
  }
  await fs.writeFile(path.join(root, "dist", "standalone", "ants-nest-cli.cjs"), "cli");
  await fs.writeFile(path.join(root, "assets", "icon.png"), "icon");
  const staged = await stageReleaseAssets({ platform: "linux", root });
  assert.deepEqual(staged.files, ["Ants.Nest.AppImage", "Ants.Nest.AppImage.blockmap", "ants-nest-cli.cjs", "ants-nest-icon.png", "latest-linux.yml"]);

  const collected = path.join(root, "collected");
  await fs.mkdir(collected);
  for (const name of staged.files) await fs.copyFile(path.join(staged.destination, name), path.join(collected, name));
  for (const name of [
    `Ants.Nest-${version}-mac-arm64.dmg`,
    `Ants.Nest-${version}-mac-arm64.zip`,
    "latest-mac.yml",
    `Ants.Nest-Setup-${version}-win-x64.exe`,
    "latest.yml",
  ]) await fs.writeFile(path.join(collected, name), name);
  const assembled = await assembleReleaseAssets({ input: collected, output: path.join(root, "release-assets"), root });
  assert.ok(assembled.files.includes("checksums.txt"));
  assert.match(await fs.readFile(path.join(assembled.output, "checksums.txt"), "utf8"), /  ants-nest-cli\.cjs$/m);
});

test("rejects unexpected files during final assembly", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ants-release-reject-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const version = "1.0.0";
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
  await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify({ version, packages: { "": { version } } }));
  const input = path.join(root, "input");
  await fs.mkdir(input);
  for (const name of [
    "Ants.Nest.AppImage",
    "latest-linux.yml",
    `Ants.Nest-${version}-mac-arm64.dmg`,
    `Ants.Nest-${version}-mac-arm64.zip`,
    "latest-mac.yml",
    `Ants.Nest-Setup-${version}-win-x64.exe`,
    "latest.yml",
    "ants-nest-cli.cjs",
    "ants-nest-icon.png",
    "debug.log",
  ]) await fs.writeFile(path.join(input, name), name);
  await assert.rejects(() => assembleReleaseAssets({ input, output: path.join(root, "output"), root }), /Unexpected combined release assets: debug\.log/);
});
