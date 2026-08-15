import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net, { type Server } from "node:net";
import path from "node:path";
import { dataDirectory } from "./paths";

function socketPath() {
  if (process.platform === "win32") {
    const id = createHash("sha256").update(dataDirectory()).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\ants-nest-${id}`;
  }
  return path.join(dataDirectory(), "state-events.sock");
}

export async function notifyStateChanged() {
  await new Promise<void>((resolve) => {
    const socket = net.createConnection(socketPath());
    const done = () => { socket.destroy(); resolve(); };
    socket.once("connect", () => socket.end("changed"));
    socket.once("error", done);
    socket.once("close", resolve);
    socket.setTimeout(300, done);
  });
}

export async function startStateChangeServer(onChange: () => void): Promise<() => Promise<void>> {
  const target = socketPath();
  await fs.mkdir(dataDirectory(), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.unlink(target).catch(() => undefined);
  const server: Server = net.createServer((socket) => {
    socket.once("data", () => onChange());
    socket.resume();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(target, resolve);
  });
  if (process.platform !== "win32") await fs.chmod(target, 0o600);
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32") await fs.unlink(target).catch(() => undefined);
  };
}
