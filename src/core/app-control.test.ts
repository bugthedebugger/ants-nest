import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestAppControl, startAppControlServer, type AppControlRequest } from "./app-control";

let directory = "";
let stopServer: (() => Promise<void>) | undefined;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "ants-control-test-"));
  process.env.ANTS_NEST_HOME = directory;
});

afterEach(async () => {
  await stopServer?.();
  stopServer = undefined;
  delete process.env.ANTS_NEST_HOME;
  await fs.rm(directory, { recursive: true, force: true });
});

describe("desktop app control socket", () => {
  it("routes remote commands over a user-only local socket", async () => {
    const requests: AppControlRequest[] = [];
    stopServer = await startAppControlServer((request) => {
      requests.push(request);
      return {
        enabled: true,
        publicUrl: "https://antsnest.example.com",
        pairingUrl: "https://antsnest.example.com/#pair=single-use",
        devices: [],
      };
    });

    const state = await requestAppControl({ operation: "remote-pair" }, 1_000);
    expect(state.pairingUrl).toContain("#pair=");
    expect(requests).toEqual([{ operation: "remote-pair" }]);
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(directory, "app-control.sock"))).mode & 0o777).toBe(0o600);
    }
  });

  it("reports a clear error when the desktop app is not running", async () => {
    await expect(requestAppControl({ operation: "remote-status" }, 100)).rejects.toThrow("Ants Nest is not running");
  });
});
