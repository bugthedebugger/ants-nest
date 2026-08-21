import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManagedTunnel, deleteManagedTunnel, saveCloudflareConfig } from "./cloudflare-api";
import { doctor } from "./cloudflared";

let directory = "";
const config = {
  proxyDomain: "tunnels.example.com",
  zoneId: "a".repeat(32),
  accountId: "b".repeat(32),
  apiToken: "test_api_token_that_is_long_enough",
};

function success(result: unknown) {
  return new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "ants-cloudflare-test-"));
  process.env.ANTS_NEST_HOME = directory;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.ANTS_NEST_HOME;
  await fs.rm(directory, { recursive: true, force: true });
});

describe("Cloudflare API setup", () => {
  it("validates setup and provisions a remote tunnel, ingress, DNS, and token file", async () => {
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("dns_records?per_page")) return success([]);
      if (url.includes("cfd_tunnel?per_page")) return success([]);
      if (url.endsWith("/cfd_tunnel") && init?.method === "POST") return success({ id: "tunnel-uuid", token: "connector-token" });
      if (url.endsWith("/configurations")) return success({});
      if (url.includes("dns_records?name=")) return success([]);
      if (url.endsWith("/dns_records") && init?.method === "POST") return success({ id: "dns-id" });
      throw new Error(`Unexpected request: ${url}`);
    }));

    await saveCloudflareConfig(config);
    const appStatus = await doctor();
    expect(appStatus.authenticated).toBe(true);
    expect(appStatus.proxyDomain).toBe("tunnels.example.com");
    expect(appStatus).not.toHaveProperty("apiToken");
    const configMode = (await fs.stat(path.join(directory, "cloudflare.json"))).mode & 0o777;
    expect(configMode).toBe(0o600);
    const managed = await createManagedTunnel({ id: "profile-id", name: "preview", hostname: "preview.tunnels.example.com", origin: "http://localhost:3000" });

    expect(managed.tunnelId).toBe("tunnel-uuid");
    expect(managed.dnsRecordId).toBe("dns-id");
    expect(await fs.readFile(managed.tokenFile, "utf8")).toBe("connector-token");
    expect(calls.some((call) => call.url.endsWith("/configurations") && String(call.init?.body).includes("http_status:404"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/dns_records") && String(call.init?.body).includes("tunnel-uuid.cfargotunnel.com"))).toBe(true);
    expect(calls.some((call) => call.init?.method === "PUT" && call.url.includes("/dns_records/"))).toBe(false);
  });

  it("refuses any hostname that already has a DNS record without creating or replacing resources", async () => {
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("dns_records?name=")) return success([{ id: "existing-record", type: "CNAME" }]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "cloudflare.json"), JSON.stringify(config), { mode: 0o600 });

    await expect(createManagedTunnel({ id: "profile-id", name: "preview", hostname: "preview.tunnels.example.com", origin: "http://localhost:3000" }))
      .rejects.toThrow("already in use by Cloudflare DNS (CNAME)");
    expect(calls.some((call) => call.url.endsWith("/cfd_tunnel") && call.init?.method === "POST")).toBe(false);
    expect(calls.some((call) => call.url.includes("/dns_records/") && call.init?.method === "PUT")).toBe(false);
  });

  it("releases only the DNS record owned by the named tunnel, then deletes the tunnel", async () => {
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("dns_records?name=")) return success([{ id: "dns-id", type: "CNAME", content: "tunnel-uuid.cfargotunnel.com", comment: "Managed by Ants Nest" }]);
      if (url.endsWith("/dns_records/dns-id") && init?.method === "DELETE") return success({ id: "dns-id" });
      if (url.endsWith("/cfd_tunnel/tunnel-uuid") && init?.method === "DELETE") return success({ id: "tunnel-uuid" });
      throw new Error(`Unexpected request: ${url}`);
    }));
    await fs.writeFile(path.join(directory, "cloudflare.json"), JSON.stringify(config), { mode: 0o600 });

    await deleteManagedTunnel({ tunnelId: "tunnel-uuid", hostname: "preview.tunnels.example.com" });
    expect(calls.filter((call) => call.init?.method === "DELETE").map((call) => call.url)).toEqual([
      expect.stringContaining("/dns_records/dns-id"),
      expect.stringContaining("/cfd_tunnel/tunnel-uuid"),
    ]);
  });

  it("refuses to delete a DNS record whose ownership does not match", async () => {
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("dns_records?name=")) return success([{ id: "foreign-id", type: "A", content: "192.0.2.1" }]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await fs.writeFile(path.join(directory, "cloudflare.json"), JSON.stringify(config), { mode: 0o600 });

    await expect(deleteManagedTunnel({ tunnelId: "tunnel-uuid", hostname: "preview.tunnels.example.com", dnsRecordId: "dns-id" }))
      .rejects.toThrow("not owned by this Ants Nest tunnel");
    expect(calls.some((call) => call.init?.method === "DELETE")).toBe(false);
  });

  it("waits for recently stopped cloudflared connections before deleting a tunnel", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
      queueMicrotask(callback);
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    let tunnelDeleteAttempts = 0;
    let connectionCleanups = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("dns_records?name=")) return success([]);
      if (url.endsWith("/cfd_tunnel/tunnel-uuid/connections") && init?.method === "DELETE") {
        connectionCleanups += 1;
        return success(null);
      }
      if (url.endsWith("/cfd_tunnel/tunnel-uuid") && init?.method === "DELETE") {
        tunnelDeleteAttempts += 1;
        if (tunnelDeleteAttempts < 3) return new Response(JSON.stringify({ success: false, result: null, errors: [{ message: "This tunnel has active connections. Please stop all cloudflared replicas." }] }), { status: 409, headers: { "Content-Type": "application/json" } });
        return success({ id: "tunnel-uuid" });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    await fs.writeFile(path.join(directory, "cloudflare.json"), JSON.stringify(config), { mode: 0o600 });

    await deleteManagedTunnel({ tunnelId: "tunnel-uuid", hostname: "preview.tunnels.example.com" });
    expect(tunnelDeleteAttempts).toBe(3);
    expect(connectionCleanups).toBe(1);
    expect(timer).toHaveBeenCalledTimes(2);
  });
});
