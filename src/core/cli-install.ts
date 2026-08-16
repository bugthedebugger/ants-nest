import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliInstallationStatus } from "../shared/types";

const managedMarker = "# Managed by Ants Nest CLI installer";

export type CliInstallTarget =
  | { mode: "appimage"; executablePath: string; version: string }
  | { mode: "repository"; nodePath: string; scriptPath: string; version: string };

type CliInstallOptions = {
  homeDirectory?: string;
  pathValue?: string;
  platform?: NodeJS.Platform;
};

function locations(homeDirectory = os.homedir()) {
  const binDirectory = path.join(homeDirectory, ".local", "bin");
  const appDirectory = path.join(homeDirectory, ".local", "share", "ants-nest");
  const applicationsDirectory = path.join(homeDirectory, ".local", "share", "applications");
  return {
    binDirectory,
    appDirectory,
    appImage: path.join(appDirectory, "Ants Nest.AppImage"),
    icon: path.join(appDirectory, "icon.png"),
    desktopEntry: path.join(applicationsDirectory, "ants-nest.desktop"),
    applicationsDirectory,
    launchers: [path.join(binDirectory, "ants"), path.join(binDirectory, "ants-nest")],
  };
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function launcherMetadata(target: CliInstallTarget) {
  return `# ants-nest-cli mode=${target.mode} version=${target.version}`;
}

function launcherScript(target: CliInstallTarget, appImage: string) {
  const command = target.mode === "appimage"
    ? `${shellQuote(appImage)} --cli`
    : `${shellQuote(target.nodePath)} ${shellQuote(target.scriptPath)}`;
  return `#!/bin/sh\n${managedMarker}\n${launcherMetadata(target)}\nunset ELECTRON_RUN_AS_NODE\nexec ${command} "$@"\n`;
}

async function readLauncher(file: string) {
  return fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

async function assertSafeLauncherTargets(files: string[]) {
  for (const file of files) {
    const existing = await readLauncher(file);
    if (existing !== undefined && !existing.includes(managedMarker)) {
      throw new Error(`${file} already exists and is not managed by Ants Nest. Move or remove it before installing.`);
    }
  }
}

async function atomicWrite(file: string, content: string, mode: number) {
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    await fs.writeFile(temporary, content, { mode });
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function atomicCopy(source: string, destination: string, mode = 0o755) {
  if (path.resolve(source) === path.resolve(destination)) return;
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    await fs.copyFile(source, temporary);
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function cliInstallationStatus(options: CliInstallOptions = {}): Promise<CliInstallationStatus> {
  const platform = options.platform || process.platform;
  const target = locations(options.homeDirectory);
  const launchers = await Promise.all(target.launchers.map(readLauncher));
  const desktopEntry = await readLauncher(target.desktopEntry);
  const managed = launchers.filter((value) => value?.includes(managedMarker)).length;
  const metadata = launchers.find((value) => value?.includes("# ants-nest-cli "))?.match(/mode=(appimage|repository) version=([^\s]+)/);
  const pathEntries = (options.pathValue ?? process.env.PATH ?? "").split(path.delimiter).map((entry) => path.resolve(entry));
  return {
    supported: platform === "linux",
    installed: managed === target.launchers.length,
    appInstalled: Boolean(desktopEntry?.includes(managedMarker)),
    binDirectory: target.binDirectory,
    commands: target.launchers.map((file) => path.basename(file)),
    onPath: pathEntries.includes(path.resolve(target.binDirectory)),
    ...(metadata?.[1] ? { mode: metadata[1] as "appimage" | "repository" } : {}),
    ...(metadata?.[2] ? { version: metadata[2] } : {}),
    ...(platform !== "linux" ? { reason: "Automatic CLI installation is currently available on Linux." } : {}),
  };
}

export async function installDesktopApp(iconSource: string, options: CliInstallOptions = {}): Promise<CliInstallationStatus> {
  const platform = options.platform || process.platform;
  if (platform !== "linux") throw new Error("Automatic AppImage installation is currently available on Linux");
  const destination = locations(options.homeDirectory);
  const existing = await readLauncher(destination.desktopEntry);
  if (existing !== undefined && !existing.includes(managedMarker)) {
    throw new Error(`${destination.desktopEntry} already exists and is not managed by Ants Nest. Move or remove it before installing.`);
  }
  await Promise.all([fs.access(destination.appImage), fs.access(iconSource)]);
  await fs.mkdir(destination.appDirectory, { recursive: true, mode: 0o700 });
  await fs.mkdir(destination.applicationsDirectory, { recursive: true, mode: 0o700 });
  await atomicCopy(iconSource, destination.icon, 0o644);
  const executable = destination.appImage.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const desktop = `[Desktop Entry]\n${managedMarker}\nType=Application\nName=Ants Nest\nComment=Local-first Cloudflare Tunnel manager\nExec="${executable}"\nIcon=${destination.icon}\nTerminal=false\nCategories=Development;Network;\nStartupWMClass=ants-nest\n`;
  await atomicWrite(destination.desktopEntry, desktop, 0o644);
  return cliInstallationStatus(options);
}

export async function installCli(target: CliInstallTarget, options: CliInstallOptions = {}): Promise<CliInstallationStatus> {
  const platform = options.platform || process.platform;
  if (platform !== "linux") throw new Error("Automatic CLI installation is currently available on Linux");
  const destination = locations(options.homeDirectory);
  await assertSafeLauncherTargets(destination.launchers);
  await fs.mkdir(destination.binDirectory, { recursive: true, mode: 0o700 });
  if (target.mode === "appimage") {
    const source = path.resolve(target.executablePath);
    await fs.access(source);
    await fs.mkdir(destination.appDirectory, { recursive: true, mode: 0o700 });
    await atomicCopy(source, destination.appImage);
  } else {
    await Promise.all([fs.access(target.nodePath), fs.access(target.scriptPath)]);
  }
  const script = launcherScript(target, destination.appImage);
  await Promise.all(destination.launchers.map((file) => atomicWrite(file, script, 0o755)));
  return cliInstallationStatus(options);
}

export async function uninstallCli(options: CliInstallOptions = {}): Promise<CliInstallationStatus> {
  const destination = locations(options.homeDirectory);
  await assertSafeLauncherTargets(destination.launchers);
  const launchers = await Promise.all(destination.launchers.map(readLauncher));
  await Promise.all(destination.launchers.map((file, index) => launchers[index]?.includes(managedMarker) ? fs.rm(file, { force: true }) : undefined));
  const desktopEntry = await readLauncher(destination.desktopEntry);
  if (!desktopEntry?.includes(managedMarker)) {
    await fs.rm(destination.appImage, { force: true }).catch(() => undefined);
    await fs.rmdir(destination.appDirectory).catch(() => undefined);
  }
  return cliInstallationStatus(options);
}

export async function uninstallAll(options: CliInstallOptions = {}): Promise<CliInstallationStatus> {
  const destination = locations(options.homeDirectory);
  const desktopEntry = await readLauncher(destination.desktopEntry);
  if (desktopEntry !== undefined && !desktopEntry.includes(managedMarker)) {
    throw new Error(`${destination.desktopEntry} is not managed by Ants Nest and will not be removed.`);
  }
  await uninstallCli(options);
  if (desktopEntry?.includes(managedMarker)) await fs.rm(destination.desktopEntry, { force: true });
  await Promise.all([fs.rm(destination.appImage, { force: true }), fs.rm(destination.icon, { force: true })]);
  await fs.rmdir(destination.appDirectory).catch(() => undefined);
  return cliInstallationStatus(options);
}
