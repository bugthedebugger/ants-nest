import { runFileShareWorker } from "./file-share-server";

const configFile = process.argv[2];
if (!configFile) throw new Error("File share worker requires a configuration file");
void runFileShareWorker(configFile).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
