import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { compareSemver, validateManifestVersions } from "./release-tools.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const root = process.cwd();
const packageMetadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const lockMetadata = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
const version = validateManifestVersions(packageMetadata, lockMetadata);
const previousRef = option("--previous-ref");
let previousVersion = option("--previous-version");

if (!previousVersion && previousRef && !/^0+$/.test(previousRef)) {
  if (!/^[0-9a-f]{40}$/i.test(previousRef)) throw new Error(`Invalid previous Git ref: ${previousRef}`);
  const previousPackage = execFileSync("git", ["show", `${previousRef}:package.json`], { cwd: root, encoding: "utf8" });
  previousVersion = JSON.parse(previousPackage).version;
}

let shouldRelease = true;
if (previousVersion) {
  const comparison = compareSemver(version, previousVersion);
  if (comparison < 0) throw new Error(`Refusing version decrease from ${previousVersion} to ${version}`);
  shouldRelease = comparison > 0;
}

const result = { version, tag: `v${version}`, previousVersion: previousVersion ?? null, shouldRelease };
const githubOutput = option("--github-output");
if (githubOutput) {
  await fs.appendFile(githubOutput, `version=${result.version}\ntag=${result.tag}\nshould_release=${result.shouldRelease}\n`);
}
console.log(JSON.stringify(result, null, 2));
