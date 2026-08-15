import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newRemotePairing, revokeRemoteDevice, startRemoteAccess, stopRemoteAccess } from "./remote";

let directory = "";
let dnsCreated = false;
const nativeFetch = globalThis.fetch;

function success(result: unknown) {
  return new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "ants-remote-test-"));
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
  await fs.writeFile(expiryWorker, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o700 });
  process.env.ANTS_NEST_EXPIRY_WORKER = expiryWorker;
  await fs.mkdir(process.env.ANTS_NEST_HOME, { recursive: true });
  await fs.writeFile(path.join(process.env.ANTS_NEST_HOME, "cloudflare.json"), JSON.stringify({
    proxyDomain: "tunnels.example.com", zoneId: "a".repeat(32), accountId: "b".repeat(32), apiToken: "test_api_token_that_is_long_enough",
  }), { mode: 0o600 });
  dnsCreated = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("http://127.0.0.1:")) return nativeFetch(url, init);
    if (url.includes("dns_records?name=")) return success(dnsCreated ? [{ id: "dns-id", type: "CNAME", content: "tunnel-uuid.cfargotunnel.com", comment: "Managed by Ants Nest" }] : []);
    if (url.endsWith("/cfd_tunnel") && init?.method === "POST") return success({ id: "tunnel-uuid", token: "connector-token" });
    if (url.endsWith("/configurations") && init?.method === "PUT") return success({});
    if (url.endsWith("/dns_records") && init?.method === "POST") { dnsCreated = true; return success({ id: "dns-id" }); }
    if (init?.method === "DELETE") { if (url.includes("/dns_records/")) dnsCreated = false; return success({}); }
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(async () => {
  await stopRemoteAccess();
  delete process.env.ANTS_NEST_HOME;
  delete process.env.CLOUDFLARED_BIN;
  delete process.env.ANTS_NEST_EXPIRY_WORKER;
  vi.unstubAllGlobals();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("remote access server", () => {
  it("exchanges a single-use pairing code for an individually revocable device token", async () => {
    const state = await startRemoteAccess();
    expect(state.enabled).toBe(true);
    expect(state.publicUrl).toBe("https://antsnest.tunnels.example.com");
    expect(state.pairingUrl).toContain("#pair=");

    const unauthorized = await fetch(`${state.localUrl}/api/tunnels`);
    expect(unauthorized.status).toBe(401);

    const pairingToken = new URLSearchParams(new URL(state.pairingUrl!).hash.slice(1)).get("pair");
    const paired = await fetch(`${state.localUrl}/api/auth/pair`, {
      method: "POST",
      headers: { Authorization: `Pairing ${pairingToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test phone" }),
    });
    expect(paired.status).toBe(201);
    const credentials = await paired.json() as { token: string; device: { id: string } };

    const reused = await fetch(`${state.localUrl}/api/auth/pair`, { method: "POST", headers: { Authorization: `Pairing ${pairingToken}` } });
    expect(reused.status).toBe(401);

    const authorized = await fetch(`${state.localUrl}/api/tunnels`, { headers: { Authorization: `Bearer ${credentials.token}` } });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual([]);

    const pendingPairing = newRemotePairing();
    const pendingToken = new URLSearchParams(new URL(pendingPairing.pairingUrl!).hash.slice(1)).get("pair");
    const afterRevoke = revokeRemoteDevice(credentials.device.id);
    expect(afterRevoke.devices).toEqual([]);
    const revoked = await fetch(`${state.localUrl}/api/tunnels`, { headers: { Authorization: `Bearer ${credentials.token}` } });
    expect(revoked.status).toBe(401);
    const invalidatedPairing = await fetch(`${state.localUrl}/api/auth/pair`, { method: "POST", headers: { Authorization: `Pairing ${pendingToken}` } });
    expect(invalidatedPairing.status).toBe(401);
    expect(newRemotePairing().pairingUrl).not.toBe(pendingPairing.pairingUrl);

    const page = await fetch(state.localUrl!).then((response) => response.text());
    expect(page).toContain("Tunnels from anywhere");
    expect(page).not.toContain(pairingToken);
  }, 10_000);
});
