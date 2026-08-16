import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteAutostartPath, setRemoteAutostart } from "./autostart";

describe("Remote access autostart", () => {
  let directory = "";

  afterEach(async () => {
    vi.restoreAllMocks();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it.runIf(process.platform === "linux")("creates and removes only its managed desktop entry", async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "ants-nest-autostart-"));
    vi.spyOn(os, "homedir").mockReturnValue(directory);
    const target = remoteAutostartPath();
    await setRemoteAutostart(true, "/tmp/Ants Nest.AppImage");
    expect(await fs.readFile(target, "utf8")).toContain('Exec="/tmp/Ants Nest.AppImage" --background --no-sandbox');
    await setRemoteAutostart(false);
    await expect(fs.access(target)).rejects.toThrow();

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "user-owned");
    await setRemoteAutostart(false);
    expect(await fs.readFile(target, "utf8")).toBe("user-owned");
  });
});
