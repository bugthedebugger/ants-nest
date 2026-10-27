import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctor, ensureSafeCloudflared, installCloudflared, spawnTunnel } from "./cloudflared";

let directory = "";

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "ants-cloudflared-install-"));
  process.env.ANTS_NEST_HOME = directory;
  delete process.env.CLOUDFLARED_BIN;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.CLOUDFLARED_BIN;
  delete process.env.ANTS_NEST_HOME;
  await fs.rm(directory, { recursive: true, force: true });
});

describe("cloudflared setup installation", () => {
  it("rejects vulnerable release metadata before downloading a binary", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tag_name: "2026.8.2", assets: [] })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(installCloudflared()).rejects.toThrow("security minimum");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform !== "win32")("reports and blocks an outdated custom executable without overwriting it", async () => {
    const binary = path.join(directory, "custom-cloudflared");
    const script = "#!/bin/sh\necho 'cloudflared version 2026.8.2'\n";
    await fs.writeFile(binary, script, { mode: 0o700 });
    process.env.CLOUDFLARED_BIN = binary;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await doctor()).toMatchObject({ installed: true, upgradeRequired: true });
    await expect(installCloudflared()).rejects.toThrow("Update CLOUDFLARED_BIN");
    await expect(spawnTunnel("blocked", ["tunnel", "run"])).rejects.toThrow("security update");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fs.readFile(binary, "utf8")).toBe(script);
    await expect(fs.stat(path.join(directory, "logs"))).rejects.toThrow();
  });

  it.runIf(process.platform === "linux" && ["x64", "arm64"].includes(process.arch))("upgrades an old managed executable and fails closed when offline", async () => {
    const destination = path.join(directory, "bin", "cloudflared");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const oldBinary = "#!/bin/sh\necho 'cloudflared version 2026.8.2'\n";
    await fs.writeFile(destination, oldBinary, { mode: 0o700 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(spawnTunnel("blocked", ["tunnel", "run"])).rejects.toThrow("offline");
    expect(await fs.readFile(destination, "utf8")).toBe(oldBinary);
    await expect(fs.stat(path.join(directory, "logs"))).rejects.toThrow();

    const binary = Buffer.from("#!/bin/sh\necho 'cloudflared version 2026.10.3'\n");
    const digest = createHash("sha256").update(binary).digest("hex");
    const name = process.arch === "arm64" ? "cloudflared-linux-arm64" : "cloudflared-linux-amd64";
    const fetchMock = vi.fn(async (url: string) => url.includes("/releases/latest")
      ? new Response(JSON.stringify({ tag_name: "2026.10.3", assets: [{ name, browser_download_url: "https://downloads.example/binary", digest: `sha256:${digest}` }] }))
      : new Response(binary));
    vi.stubGlobal("fetch", fetchMock);
    await ensureSafeCloudflared();
    expect(await fs.readFile(destination)).toEqual(binary);
    expect(await doctor()).toMatchObject({ installed: true, upgradeRequired: false });
    await ensureSafeCloudflared();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.runIf(process.platform === "linux" && ["x64", "arm64"].includes(process.arch))("downloads the latest platform asset and verifies Cloudflare's checksum", async () => {
    const binary = Buffer.from("test cloudflared binary");
    const digest = createHash("sha256").update(binary).digest("hex");
    const assetName = process.arch === "arm64" ? "cloudflared-linux-arm64" : "cloudflared-linux-amd64";
    const downloadUrl = `https://downloads.example/${assetName}`;
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/releases/latest")) return new Response(JSON.stringify({
        tag_name: "2099.1.0",
        body: `${assetName}: ${digest}`,
        assets: [{ name: assetName, browser_download_url: downloadUrl, digest: `sha256:${digest}` }],
      }), { status: 200 });
      if (String(url) === downloadUrl) return new Response(binary, { status: 200 });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const installed = await installCloudflared();
    expect(await fs.readFile(installed)).toEqual(binary);
    expect((await fs.stat(installed)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await fs.readFile(path.join(directory, "bin", "cloudflared.json"), "utf8"))).toMatchObject({ version: "2099.1.0", sha256: digest, asset: assetName });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await installCloudflared();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
