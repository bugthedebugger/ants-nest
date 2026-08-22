import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareVersions, fetchLatestRelease, normalizeVersion, parseChecksums, resolveCliUpdateTarget, runCliUpdate } from "./cli-update";

let directory = "";

beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "ants-cli-update-test-")); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

function releaseResponse(version: string) {
  return new Response(JSON.stringify({
    tag_name: `v${version}`,
    assets: [
      { name: "ants-nest-cli.cjs", browser_download_url: "mock://asset/cli.cjs" },
      { name: "checksums.txt", browser_download_url: "mock://asset/checksums.txt" },
    ],
  }), { status: 200 });
}

function mockFetch(newScript: string) {
  const checksum = createHash("sha256").update(newScript).digest("hex");
  return (async (url: RequestInfo | URL) => {
    const value = String(url);
    if (value === "https://api.github.com/repos/bugthedebugger/ants-nest/releases/latest") return releaseResponse("9.9.9");
    if (value === "mock://asset/checksums.txt") return new Response(`${checksum}  ants-nest-cli.cjs\n`, { status: 200 });
    if (value === "mock://asset/cli.cjs") return new Response(newScript, { status: 200 });
    throw new Error(`Unexpected fetch: ${value}`);
  }) as typeof fetch;
}

describe("CLI updater", () => {
  it("normalizes tags and compares versions", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("0.2.10", "0.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.1.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
  });

  it("parses checksum files", () => {
    const first = "a".repeat(64);
    const second = "deadbeef00000000000000000000000000000000000000000000000000000000";
    const parsed = parseChecksums(`${first}  file.cjs\n${second} *other.AppImage\nnoise\n`);
    expect(parsed["file.cjs"]).toBe(first);
    expect(parsed["other.AppImage"]).toBe(second);
  });

  it("resolves the update target from the runtime context", () => {
    expect(resolveCliUpdateTarget({ argv1: "/repo/node_modules/ants-nest/cli.cjs", appImage: null })).toEqual({ mode: "npm", packageName: "ants-nest" });
    expect(resolveCliUpdateTarget({ argv1: "/opt/Ants Nest.AppImage", appImage: "/opt/Ants Nest.AppImage" })).toMatchObject({ mode: "appimage", assetName: "Ants.Nest.AppImage" });
    expect(resolveCliUpdateTarget({ argv1: "/home/x/.local/share/ants-nest/cli.cjs", appImage: null })).toMatchObject({ mode: "repository", assetName: "ants-nest-cli.cjs" });
  });

  it("reads the latest release and its checksums from GitHub", async () => {
    const release = await fetchLatestRelease(mockFetch("unused"));
    expect(release.version).toBe("9.9.9");
    expect(release.assets["ants-nest-cli.cjs"]).toBe("mock://asset/cli.cjs");
    expect(release.checksums?.["ants-nest-cli.cjs"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports up-to-date without downloading when versions match", async () => {
    let downloads = 0;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      if (String(url).includes("releases/latest")) return releaseResponse("1.0.0");
      if (String(url) === "mock://asset/cli.cjs") { downloads += 1; throw new Error("should not download"); }
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const result = await runCliUpdate({ currentVersion: "1.0.0", fetchImpl, target: { mode: "repository", scriptPath: path.join(directory, "cli.cjs"), assetName: "ants-nest-cli.cjs" } });
    expect(result).toMatchObject({ updated: false, reason: "up-to-date" });
    expect(downloads).toBe(0);
  });

  it("downloads, verifies, smoke-tests, and atomically swaps a repository CLI", async () => {
    const scriptPath = path.join(directory, "cli.cjs");
    await fs.writeFile(scriptPath, "process.stdout.write('1.0.0')");
    const newScript = `process.stdout.write('9.9.9')`;
    const result = await runCliUpdate({ currentVersion: "1.0.0", fetchImpl: mockFetch(newScript), target: { mode: "repository", scriptPath, assetName: "ants-nest-cli.cjs" } });
    expect(result).toMatchObject({ updated: true, latestVersion: "9.9.9", targetPath: scriptPath });
    expect(await fs.readFile(scriptPath, "utf8")).toBe(newScript);
    expect((await fs.stat(scriptPath)).mode & 0o777).toBe(0o755);
    await expect(fs.access(`${scriptPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(directory)).resolves.toEqual(["cli.cjs"]);
  });

  it("rejects a download whose checksum does not match", async () => {
    const scriptPath = path.join(directory, "cli.cjs");
    await fs.writeFile(scriptPath, "old");
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.includes("releases/latest")) return releaseResponse("9.9.9");
      if (value.includes("checksums.txt")) return new Response(`${"0".repeat(64)}  ants-nest-cli.cjs\n`, { status: 200 });
      if (value === "mock://asset/cli.cjs") return new Response("tampered", { status: 200 });
      throw new Error(`Unexpected fetch: ${value}`);
    }) as typeof fetch;
    await expect(runCliUpdate({ currentVersion: "1.0.0", fetchImpl, target: { mode: "repository", scriptPath, assetName: "ants-nest-cli.cjs" } })).rejects.toThrow("Checksum mismatch");
    expect(await fs.readFile(scriptPath, "utf8")).toBe("old");
  });

  it("points npm-managed installs at their package manager instead of swapping files", async () => {
    const result = await runCliUpdate({ currentVersion: "1.0.0", fetchImpl: mockFetch("x"), target: { mode: "npm", packageName: "ants-nest" } });
    expect(result.updated).toBe(false);
    expect(result.reason).toContain("npm install -g ants-nest@9.9.9");
  });
});
