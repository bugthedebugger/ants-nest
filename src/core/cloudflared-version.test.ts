import { describe, expect, it } from "vitest";
import { isCloudflaredVersionSafe } from "./cloudflared-version";

describe("cloudflared security minimum", () => {
  it.each([
    ["2026.8.2", "linux", false],
    ["2026.10.1", "win32", false],
    ["2026.10.2", "linux", true],
    ["2026.10.2", "darwin", false],
    ["2026.10.3", "darwin", true],
    ["2026.10.4", "linux", true],
    ["2027.1.0", "darwin", true],
    ["v2026.10.3", "darwin", true],
    ["cloudflared version 2026.10.3 (built 2026-10-21)", "darwin", true],
    ["cloudflared version test", "linux", false],
    ["2026.10.3-rc1", "linux", false],
    ["", "linux", false],
  ])("checks %s on %s", (version, platform, expected) => {
    expect(isCloudflaredVersionSafe(version, platform)).toBe(expected);
  });
});
