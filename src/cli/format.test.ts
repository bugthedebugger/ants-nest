import { describe, expect, it } from "vitest";
import type { TunnelView } from "../shared/types";
import { formatTunnelList } from "./format";

const tunnel: TunnelView = {
  id: "506a4e8a-0000-0000-0000-000000000000", profileId: "506a4e8a-0000-0000-0000-000000000000",
  name: "Neon grid demo", description: "Retro neon-grid static demo page shared directly from disk",
  kind: "quick", origin: "http://127.0.0.1:36779", sharedPath: "/a/very/long/path/to/the/demo-folder",
  tokenRequired: true, status: "failed", publicUrl: "https://neon-grid-demo-quick.example.com/#token=abcdefghijklmnopqrstuvwxyz",
  error: "Tunnel cleanup is taking longer than expected", createdAt: "2026-08-21T00:00:00.000Z",
};

describe("CLI tunnel list", () => {
  it("renders compact cards that fit a narrow terminal", () => {
    const output = formatTunnelList([tunnel], 48);
    expect(output).toContain("× FAILED Neon grid demo");
    expect(output).toContain("506a4e8a · quick · token");
    expect(output).not.toContain("|");
    expect(output.split("\n").every((line) => line.length <= 48)).toBe(true);
  });
});
