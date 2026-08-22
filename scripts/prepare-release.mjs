import process from "node:process";
import { stageReleaseAssets } from "./release-tools.mjs";

const defaultPlatform = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux";
const platform = process.argv[2] ?? defaultPlatform;
const result = await stageReleaseAssets({ platform });
console.log(`Staged Ants Nest ${result.version} ${platform} assets:\n${result.files.join("\n")}`);
