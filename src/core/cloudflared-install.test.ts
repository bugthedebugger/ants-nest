import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installCloudflared } from "./cloudflared";

let directory = "";

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "ants-cloudflared-install-"));
  process.env.ANTS_NEST_HOME = directory;
  delete process.env.CLOUDFLARED_BIN;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.ANTS_NEST_HOME;
  await fs.rm(directory, { recursive: true, force: true });
});

describe("cloudflared setup installation", () => {
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
