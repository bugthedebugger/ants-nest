import path from "node:path";
import process from "node:process";
import { assembleReleaseAssets } from "./release-tools.mjs";

const input = path.resolve(process.argv[2] ?? "collected-artifacts");
const output = path.resolve(process.argv[3] ?? "release-assets");
const result = await assembleReleaseAssets({ input, output });
console.log(`Assembled Ants Nest ${result.version} release assets:\n${result.files.join("\n")}`);
