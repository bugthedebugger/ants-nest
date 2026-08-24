import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createFileShareServer } from "./file-share-server";

const directories: string[] = [];
const servers: Array<Awaited<ReturnType<typeof createFileShareServer>>> = [];

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ants-file-share-"));
  directories.push(directory);
  await fs.writeFile(path.join(directory, "index.html"), "<h1>private preview</h1>");
  await fs.writeFile(path.join(directory, "notes.txt"), "secret notes");
  return directory;
}

async function start(sharedPath: string, token?: string) {
  const server = await createFileShareServer({ path: sharedPath, port: 0, ...(token ? { token } : {}) });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("file share server", () => {
  it("rejects a bare link, accepts a URL token, and authorizes later asset requests with a cookie", async () => {
    const directory = await fixture();
    const base = await start(directory, "abcdef");

    const bare = await fetch(base);
    expect(bare.status).toBe(401);
    const authPage = await bare.text();
    expect(authPage).toContain("Token required");
    expect(authPage).toContain("location.hash.slice(1)");
    expect(authPage).toContain("history.replaceState");

    const authorized = await fetch(`${base}/?token=abcdef`, { redirect: "manual" });
    expect(authorized.status).toBe(303);
    expect(authorized.headers.get("location")).toBe("/");
    const cookie = authorized.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");

    const file = await fetch(`${base}/notes.txt`, { headers: { Cookie: cookie.split(";")[0]! } });
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("secret notes");
  });

  it("keeps invalid tokens locked and allows an explicit token-free share", async () => {
    const directory = await fixture();
    const protectedBase = await start(path.join(directory, "notes.txt"), "correct-token");
    expect((await fetch(`${protectedBase}/?token=wrong`)).status).toBe(401);

    const publicBase = await start(path.join(directory, "notes.txt"));
    const response = await fetch(publicBase);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("secret notes");
  });

  it("does not serve paths outside a shared folder", async () => {
    const directory = await fixture();
    const base = await start(directory);
    expect((await fetch(`${base}/../outside.txt`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/outside.txt`)).status).toBe(404);
  });
});
