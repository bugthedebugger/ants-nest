import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliInstallationStatus, installCli, installDesktopApp, probeDesktopCliVersion, uninstallAll, uninstallCli } from "./cli-install";

let directory = "";

beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "ants-cli-install-test-")); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

describe("CLI installer", () => {
  it("reads the real version from a packaged desktop executable", async () => {
    const executable = path.join(directory, "fake-desktop");
    await fs.writeFile(executable, "#!/bin/sh\nprintf '2.3.4\\n'\n", { mode: 0o755 });
    expect(await probeDesktopCliVersion(executable)).toBe("2.3.4");
  });

  it("installs AppImage-backed commands and removes only managed files", async () => {
    const source = path.join(directory, "downloaded.AppImage");
    const fontconfig = path.join(directory, "fontconfig-cli.conf");
    await fs.writeFile(source, "fake appimage", { mode: 0o755 });
    await fs.writeFile(fontconfig, "<fontconfig/>");
    const options = { homeDirectory: path.join(directory, "home"), platform: "linux" as const, pathValue: path.join(directory, "home", ".local", "bin") };
    const installed = await installCli({ mode: "appimage", executablePath: source, fontconfigPath: fontconfig, version: "1.2.3" }, options);
    expect(installed).toMatchObject({ installed: true, onPath: true, mode: "appimage", version: "1.2.3" });
    const launcher = await fs.readFile(path.join(options.homeDirectory, ".local", "bin", "ants"), "utf8");
    expect(launcher).toContain("Ants Nest.AppImage' --cli");
    expect(launcher).toContain("export FONTCONFIG_FILE=");
    expect((await fs.stat(path.join(options.homeDirectory, ".local", "bin", "ants"))).mode & 0o777).toBe(0o755);
    expect(await fs.readFile(path.join(options.homeDirectory, ".local", "share", "ants-nest", "Ants Nest.AppImage"), "utf8")).toBe("fake appimage");
    expect(await fs.readFile(path.join(options.homeDirectory, ".local", "share", "ants-nest", "fontconfig-cli.conf"), "utf8")).toBe("<fontconfig/>");
    const icon = path.join(directory, "icon.png");
    await fs.writeFile(icon, "fake icon");
    expect((await installDesktopApp(icon, options)).appInstalled).toBe(true);
    const afterCliRemoval = await uninstallCli(options);
    expect(afterCliRemoval).toMatchObject({ installed: false, appInstalled: true });
    await expect(fs.access(path.join(options.homeDirectory, ".local", "share", "ants-nest", "Ants Nest.AppImage"))).resolves.toBeUndefined();
    expect((await uninstallAll(options)).appInstalled).toBe(false);
  });

  it("installs a repository CLI launcher and refuses to replace foreign commands", async () => {
    const nodePath = path.join(directory, "node");
    const scriptPath = path.join(directory, "index.cjs");
    await Promise.all([fs.writeFile(nodePath, "node"), fs.writeFile(scriptPath, "cli")]);
    const homeDirectory = path.join(directory, "home");
    const options = { homeDirectory, platform: "linux" as const };
    await installCli({ mode: "repository", nodePath, scriptPath, version: "1.2.3" }, options);
    const launcher = await fs.readFile(path.join(homeDirectory, ".local", "bin", "ants-nest"), "utf8");
    expect(launcher).toContain(`'${nodePath}' '${scriptPath}'`);
    await fs.writeFile(path.join(homeDirectory, ".local", "bin", "ants"), "#!/bin/sh\necho foreign\n");
    await expect(installCli({ mode: "repository", nodePath, scriptPath, version: "1.2.4" }, options)).rejects.toThrow("not managed by Ants Nest");
  });

  it("installs repository launchers on macOS and Windows", async () => {
    const nodePath = path.join(directory, "node");
    const scriptPath = path.join(directory, "index.cjs");
    await Promise.all([fs.writeFile(nodePath, "node"), fs.writeFile(scriptPath, "cli")]);

    const macHome = path.join(directory, "mac-home");
    expect(await installCli({ mode: "repository", nodePath, scriptPath, version: "1.2.3" }, { homeDirectory: macHome, platform: "darwin" })).toMatchObject({ supported: true, installed: true });
    expect(await fs.readFile(path.join(macHome, ".local", "bin", "ants"), "utf8")).toContain("#!/bin/sh");

    const windowsHome = path.join(directory, "windows-home");
    expect(await installCli({ mode: "repository", nodePath, scriptPath, version: "1.2.3" }, { homeDirectory: windowsHome, platform: "win32" })).toMatchObject({ supported: true, installed: true });
    const launcher = await fs.readFile(path.join(windowsHome, "AppData", "Local", "Ants Nest", "bin", "ants-nest.cmd"), "utf8");
    expect(launcher).toContain("@echo off");
    expect(launcher).toContain(`"${nodePath}" "${scriptPath}" %*`);
  });

  it("installs desktop-backed launchers on macOS and Windows", async () => {
    const executablePath = path.join(directory, "Ants Nest executable");
    await fs.writeFile(executablePath, "desktop app");

    const macHome = path.join(directory, "mac-desktop-home");
    await installCli({ mode: "desktop", executablePath, version: "1.2.3" }, { homeDirectory: macHome, platform: "darwin" });
    expect(await fs.readFile(path.join(macHome, ".local", "bin", "ants"), "utf8")).toContain(`'${executablePath}' --cli`);

    const windowsHome = path.join(directory, "windows-desktop-home");
    await installCli({ mode: "desktop", executablePath, version: "1.2.3" }, { homeDirectory: windowsHome, platform: "win32" });
    expect(await fs.readFile(path.join(windowsHome, "AppData", "Local", "Ants Nest", "bin", "ants.cmd"), "utf8")).toContain(`"${executablePath}" --cli %*`);
  });
});
