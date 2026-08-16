#!/usr/bin/env node
import path from "node:path";
import packageMetadata from "../../package.json";
import { installCli, installDesktopApp, uninstallAll, uninstallCli } from "../core/cli-install";

async function main() {
  const operation = process.argv[2];
  if (!["install", "install-all", "uninstall", "uninstall-all"].includes(operation || "")) throw new Error("Usage: install-runner <install|install-all|uninstall|uninstall-all>");
  let status;
  if (operation === "install") {
    status = await installCli({ mode: "repository", nodePath: process.execPath, scriptPath: path.resolve("dist/cli/index.cjs"), version: packageMetadata.version });
  } else if (operation === "install-all") {
    const appImage = path.resolve("release", `Ants.Nest-${packageMetadata.version}.AppImage`);
    status = await installCli({ mode: "appimage", executablePath: appImage, fontconfigPath: path.resolve("assets/fontconfig-cli.conf"), version: packageMetadata.version });
    status = await installDesktopApp(path.resolve("assets/icon.png"));
  } else if (operation === "uninstall-all") status = await uninstallAll();
  else status = await uninstallCli();
  console.log(status.installed
    ? `${operation === "install-all" ? "Installed the Ants Nest app plus ants and ants-nest" : "Installed ants and ants-nest"} in ${status.binDirectory}${status.onPath ? "" : `\nAdd ${status.binDirectory} to PATH.`}`
    : operation === "uninstall-all" ? "Removed the Ants Nest app and CLI launchers" : "Removed the Ants Nest CLI launchers");
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
