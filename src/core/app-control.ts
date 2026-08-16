import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net, { type Server } from "node:net";
import path from "node:path";
import type { RemoteAccessState } from "../shared/types";
import { dataDirectory } from "./paths";

export type AppControlRequest =
  | { operation: "remote-status" }
  | { operation: "remote-enable" }
  | { operation: "remote-pair" }
  | { operation: "remote-revoke"; deviceId: string }
  | { operation: "remote-revoke-all" }
  | { operation: "remote-disable" };

type AppControlResponse =
  | { ok: true; value: RemoteAccessState }
  | { ok: false; error: string };

const maximumRequestBytes = 8192;
const maximumResponseBytes = 1024 * 1024;

function socketPath() {
  if (process.platform === "win32") {
    const id = createHash("sha256").update(dataDirectory()).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\ants-nest-control-${id}`;
  }
  return path.join(dataDirectory(), "app-control.sock");
}

function unavailableError() {
  return new Error("Ants Nest is not running. Open the desktop app and try again.");
}

export async function requestAppControl(request: AppControlRequest, timeoutMs = 65_000): Promise<RemoteAccessState> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath());
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error, value?: RemoteAccessState) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    socket.once("connect", () => socket.end(JSON.stringify(request)));
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximumResponseBytes) return finish(new Error("The Ants Nest response was too large"));
      chunks.push(chunk);
    });
    socket.once("end", () => {
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AppControlResponse;
        if (!response.ok) return finish(new Error(response.error));
        finish(undefined, response.value);
      } catch {
        finish(new Error("Ants Nest returned an invalid response"));
      }
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(error.code || "")) finish(unavailableError());
      else finish(error);
    });
    socket.setTimeout(timeoutMs, () => finish(new Error("Ants Nest did not respond in time")));
  });
}

export async function startAppControlServer(handler: (request: AppControlRequest) => Promise<RemoteAccessState> | RemoteAccessState): Promise<() => Promise<void>> {
  const target = socketPath();
  await fs.mkdir(dataDirectory(), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.unlink(target).catch(() => undefined);
  const server: Server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = [];
    let size = 0;
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximumRequestBytes) socket.destroy(new Error("Request is too large"));
      else chunks.push(chunk);
    });
    socket.once("end", async () => {
      let response: AppControlResponse;
      try {
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AppControlRequest;
        response = { ok: true, value: await handler(request) };
      } catch (error) {
        response = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (!socket.destroyed) socket.end(JSON.stringify(response));
    });
    socket.on("error", () => undefined);
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
