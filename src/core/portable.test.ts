import { afterEach, describe, expect, it, vi } from "vitest";
import { isPortableWindows, portableExecutablePath } from "./portable";

describe("portable Windows detection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns undefined outside Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.stubEnv("PORTABLE_EXECUTABLE_FILE", "/tmp/Ants.Nest-Portable.exe");
    expect(portableExecutablePath()).toBeUndefined();
    expect(isPortableWindows()).toBe(false);
  });

  it("uses PORTABLE_EXECUTABLE_FILE on Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("PORTABLE_EXECUTABLE_FILE", "C:\\Apps\\Ants.Nest-Portable.exe");
    expect(portableExecutablePath()).toBe("C:\\Apps\\Ants.Nest-Portable.exe");
    expect(isPortableWindows()).toBe(true);
  });

  it("treats blank values as not portable", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("PORTABLE_EXECUTABLE_FILE", "   ");
    expect(portableExecutablePath()).toBeUndefined();
    expect(isPortableWindows()).toBe(false);
  });

  it("reports false when the variable is unset", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("PORTABLE_EXECUTABLE_FILE", "");
    expect(isPortableWindows()).toBe(false);
  });
});
