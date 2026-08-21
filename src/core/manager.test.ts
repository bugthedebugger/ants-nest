import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopNamed, createDesktopQuick, createFileQuick, createNamed, createQuick, expireTunnel, listTunnels, stopTunnel } from "./manager";
import { isRunning } from "./cloudflared";

let directory = "";
let dnsCreated = false;

function success(result: unknown) {
  return new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "ants-nest-test-"));
  const binary = path.join(directory, "fake-cloudflared");
  await fs.writeFile(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('cloudflared version test'); process.exit(0); }
console.error('INF Registered tunnel connection');
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  process.env.ANTS_NEST_HOME = path.join(directory, "data");
  process.env.CLOUDFLARED_BIN = binary;
  const expiryWorker = path.join(directory, "fake-expiry-worker");
  await fs.writeFile(expiryWorker, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
  process.env.ANTS_NEST_EXPIRY_WORKER = expiryWorker;
  const fileShareWorker = path.join(directory, "fake-file-share-worker.cjs");
  await fs.writeFile(fileShareWorker, `const fs=require('node:fs');const http=require('node:http');const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));http.createServer((_request,response)=>response.end('shared')).listen(config.port,'127.0.0.1');`);
  process.env.ANTS_NEST_FILE_SHARE_WORKER = fileShareWorker;
  await fs.mkdir(process.env.ANTS_NEST_HOME, { recursive: true });
  await fs.writeFile(path.join(process.env.ANTS_NEST_HOME, "cloudflare.json"), JSON.stringify({
    proxyDomain: "tunnels.example.com", zoneId: "a".repeat(32), accountId: "b".repeat(32), apiToken: "test_api_token_that_is_long_enough",
  }), { mode: 0o600 });
  dnsCreated = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("dns_records?name=")) return success(dnsCreated ? [{ id: "dns-id", type: "CNAME", content: "tunnel-uuid.cfargotunnel.com", comment: "Managed by Ants Nest" }] : []);
    if (url.endsWith("/cfd_tunnel") && init?.method === "POST") return success({ id: "tunnel-uuid", token: "connector-token" });
    if (url.endsWith("/configurations") && init?.method === "PUT") return success({});
    if (url.endsWith("/dns_records") && init?.method === "POST") { dnsCreated = true; return success({ id: "dns-id" }); }
    if (init?.method === "DELETE") { if (url.includes("/dns_records/")) dnsCreated = false; return success({}); }
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(async () => {
  const tunnels = await listTunnels().catch(() => []);
  await Promise.all(tunnels.map((tunnel) => stopTunnel(tunnel.id).catch(() => undefined)));
  delete process.env.ANTS_NEST_HOME;
  delete process.env.CLOUDFLARED_BIN;
  delete process.env.ANTS_NEST_EXPIRY_WORKER;
  delete process.env.ANTS_NEST_FILE_SHARE_WORKER;
  vi.unstubAllGlobals();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("tunnel manager", () => {
  it("starts, discovers, persists, and stops a quick tunnel", async () => {
    const started = await createQuick({ name: "Agent preview", description: "Preview the agent workspace", origin: "4173", expiresInSeconds: 300 });
    expect(started.status).toBe("online");
    expect(started.publicUrl).toBe("https://agent-preview-quick.tunnels.example.com");
    expect(started.origin).toBe("http://localhost:4173");
    expect(started.description).toBe("Preview the agent workspace");
    expect(isRunning(started.expiryPid)).toBe(true);
    expect((await listTunnels())[0]?.status).toBe("online");

    const stopped = await stopTunnel(started.id);
    expect(stopped.status).toBe("stopped");
    expect(isRunning(started.expiryPid)).toBe(false);
    expect(await listTunnels()).toEqual([]);
  }, 10_000);

  it("assigns a deadline and only expires the matching tunnel session", async () => {
    const started = await createQuick({ name: "Temporary preview", description: "Short-lived integration preview", origin: "4173", expiresInSeconds: 60 });
    expect(started.expiresAt).toBeTruthy();
    expect(await expireTunnel(started.id, new Date(0).toISOString())).toBe(false);
    expect((await listTunnels())[0]?.status).toBe("online");
    expect(await expireTunnel(started.id, started.expiresAt!)).toBe(true);
    expect(await listTunnels()).toEqual([]);
  }, 10_000);

  it("derives named routes under the reserved share namespace", async () => {
    const started = await createNamed({ name: "Docs Preview", description: "Stable documentation review", origin: "3000" });
    expect(started.publicUrl).toBe("https://docs-preview-share.tunnels.example.com");
    await stopTunnel(started.id);
    expect(await listTunnels()).toEqual([]);
  }, 10_000);

  it("hosts a file itself and returns a protected link by default", async () => {
    const file = path.join(directory, "file.html");
    await fs.writeFile(file, "<h1>Review me</h1>");
    const started = await createFileQuick({ name: "File preview", description: "Private HTML preview", path: file, expiresInSeconds: 300 });
    expect(started.status).toBe("online");
    expect(started.sharedPath).toBe(file);
    expect(started.tokenRequired).toBe(true);
    expect(started.baseUrl).toBe("https://file-preview-quick.tunnels.example.com");
    expect(started.publicUrl).toMatch(/^https:\/\/file-preview-quick\.tunnels\.example\.com\/\?token=[A-Za-z0-9_-]{32}$/);
    expect(started.tokenFile).toBeUndefined();
    expect(started.shareConfigFile).toBeUndefined();
    expect(isRunning(started.fileServerPid)).toBe(true);
    await stopTunnel(started.id);
    expect(isRunning(started.fileServerPid)).toBe(false);
  }, 10_000);

  it("lets the desktop choose an unsuffixed first-level hostname", async () => {
    const quick = await createDesktopQuick({ name: "Client review", description: "Desktop-selected quick hostname", origin: "3000", hostname: "review.tunnels.example.com", expiresInSeconds: 300 });
    expect(quick.publicUrl).toBe("https://review.tunnels.example.com");
    await stopTunnel(quick.id);

    const named = await createDesktopNamed({ name: "Documentation", description: "Desktop-selected named hostname", origin: "3000", hostname: "docs.tunnels.example.com" });
    expect(named.publicUrl).toBe("https://docs.tunnels.example.com");
    await stopTunnel(named.id);
  }, 10_000);

  it("keeps desktop choices inside the configured first-level namespace", async () => {
    await expect(createDesktopNamed({ name: "Bad route", description: "Outside the configured zone", origin: "3000", hostname: "outside.example.org" })).rejects.toThrow("must be under tunnels.example.com");
    await expect(createDesktopNamed({ name: "Deep route", description: "Would require deeper TLS coverage", origin: "3000", hostname: "deep.docs.tunnels.example.com" })).rejects.toThrow("first-level hostname");
  });
});
