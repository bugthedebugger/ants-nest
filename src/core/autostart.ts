import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const marker = "# Managed by Ants Nest Remote access";

function desktopExecArgument(value: string) {
  return `"${value.replace(/[\\"`$]/g, "\\$&")}"`;
}

export function remoteAutostartPath() {
  return path.join(os.homedir(), ".config", "autostart", "ants-nest-remote.desktop");
}

export async function setRemoteAutostart(enabled: boolean, executablePath?: string) {
  if (process.platform !== "linux") return;
  const target = remoteAutostartPath();
  if (!enabled) {
    const existing = await fs.readFile(target, "utf8").catch(() => "");
    if (existing.includes(marker)) await fs.rm(target, { force: true });
    return;
  }
  if (!executablePath) return;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const entry = `[Desktop Entry]\n${marker}\nType=Application\nName=Ants Nest Remote access\nComment=Keep the Ants Nest remote dashboard available\nExec=${desktopExecArgument(executablePath)} --background --no-sandbox\nTerminal=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n`;
  await fs.writeFile(target, entry, { mode: 0o600 });
}
