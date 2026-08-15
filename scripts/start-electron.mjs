import { spawn } from "node:child_process";
import electron from "electron";

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ["."], {
  env: environment,
  stdio: "inherit",
  windowsHide: false,
});

child.on("exit", (code) => process.exit(code ?? 0));
