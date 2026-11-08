import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitUntilReady } from "./cloudflared";

const logPath = "/test/connector.log";
const pid = 12345;
let content = "";
let alive = true;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("ANTS_NEST_STARTUP_TIMEOUT_MS", undefined);
  content = "";
  alive = true;
  vi.spyOn(fs, "readFile").mockImplementation(async () => content);
  vi.spyOn(process, "kill").mockImplementation(() => {
    if (!alive) throw new Error("ESRCH");
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("cloudflared readiness", () => {
  it("allows optional feature DNS failures and initialization longer than the old 20s window", async () => {
    content = "ERR Failed to fetch features, default to disable error=TXT lookup timeout";
    const ready = waitUntilReady(logPath, pid);
    const result = expect(ready).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    content += "\nINF Registered tunnel connection connIndex=0 protocol=quic";
    await vi.advanceTimersByTimeAsync(150);
    await result;
  });

  it("allows repeated QUIC failures and HTTP/2 fallback before registration", async () => {
    content = "ERR Failed to fetch features, default to disable";
    const ready = waitUntilReady(logPath, pid);
    const result = expect(ready).resolves.toBeUndefined();
    for (let attempt = 0; attempt < 3; attempt++) {
      content += "\nERR failed to dial to edge with quic: timeout: no recent network activity\nINF Retrying connection in up to 2s";
      await vi.advanceTimersByTimeAsync(10_000);
    }
    content += "\nINF Switching to fallback protocol http2\nINF Connection abc registered protocol=http2";
    await vi.advanceTimersByTimeAsync(150);
    await result;
  });

  it.each([
    "ERR Provided Tunnel token is not valid.",
    "ERR Invalid tunnel token",
    "ERR Cannot read tunnel token file: permission denied",
    "ERR Tunnel credentials file '/test/missing.json' doesn't exist or is not a file",
    "ERR Unable to load credentials: invalid JSON",
    "ERR error parsing YAML in config file",
    "ERR Invalid ingress configuration",
    "ERR authentication failed",
  ])("rejects terminal configuration/authentication errors: %s", async (fatal) => {
    // An earlier recoverable ERR must not hide a later terminal failure.
    content = `ERR Failed to fetch features, default to disable\n${fatal}`;
    await expect(waitUntilReady(logPath, pid)).rejects.toThrow(fatal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a process exit even when a registration is in the log", async () => {
    content = "INF Registered tunnel connection";
    alive = false;
    await expect(waitUntilReady(logPath, pid)).rejects.toThrow("exited before becoming ready");
  });

  it("detects an exit during startup without waiting for the deadline", async () => {
    const ready = waitUntilReady(logPath, pid);
    const result = expect(ready).rejects.toThrow("exited before becoming ready");
    await vi.advanceTimersByTimeAsync(150);
    alive = false;
    await vi.advanceTimersByTimeAsync(150);
    await result;
  });

  it("bounds unknown errors and continuing retries at the configured deadline", async () => {
    vi.stubEnv("ANTS_NEST_STARTUP_TIMEOUT_MS", "1000");
    content = "ERR Failed to connect: network unreachable\nERR unknown future error";
    const ready = waitUntilReady(logPath, pid);
    const result = expect(ready).rejects.toThrow("Timed out after 1000ms");
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a bounded 120s default even when the log is missing", async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
    const ready = waitUntilReady(logPath, pid);
    const result = expect(ready).rejects.toThrow("Timed out after 120000ms");
    await vi.advanceTimersByTimeAsync(120_000);
    await result;
  });

  it.each(["", "NaN", "0", "-1", "1.5", "600001", "Infinity"])("rejects invalid deadline setting %j", async (value) => {
    vi.stubEnv("ANTS_NEST_STARTUP_TIMEOUT_MS", value);
    await expect(waitUntilReady(logPath, pid)).rejects.toThrow("ANTS_NEST_STARTUP_TIMEOUT_MS must be an integer");
  });
});
