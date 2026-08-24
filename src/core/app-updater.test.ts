import { describe, expect, it } from "vitest";
import { manualUpdateAssetName } from "./app-updater";

describe("desktop updater platform fallback", () => {
  it("selects the matching macOS DMG for manual installation", () => {
    expect(manualUpdateAssetName("1.2.3", "darwin", "arm64", false)).toBe("Ants.Nest-1.2.3-mac-arm64.dmg");
  });

  it("selects the portable Windows executable", () => {
    expect(manualUpdateAssetName("1.2.3", "win32", "x64", true)).toBe("Ants.Nest-Portable-1.2.3-win-x64.exe");
  });

  it("uses electron-updater for installable desktop packages", () => {
    expect(manualUpdateAssetName("1.2.3", "linux", "x64", false)).toBeUndefined();
    expect(manualUpdateAssetName("1.2.3", "win32", "x64", false)).toBeUndefined();
  });
});
