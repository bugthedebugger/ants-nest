import { describe, expect, it } from "vitest";
import { hostnameFromSubdomain, normalizeOrigin, slug, validateHostname } from "./validation";
import { parseDuration, parseExpirationTime } from "./duration";
import { fileQuickInputSchema, namedInputSchema, quickInputSchema } from "./types";

describe("normalizeOrigin", () => {
  it("expands port shorthand", () => expect(normalizeOrigin("3000")).toBe("http://localhost:3000"));
  it("adds an HTTP scheme", () => expect(normalizeOrigin("localhost:5173")).toBe("http://localhost:5173"));
  it("keeps supported protocols", () => expect(normalizeOrigin("tcp://127.0.0.1:5432")).toBe("tcp://127.0.0.1:5432"));
  it("rejects unsupported protocols", () => expect(() => normalizeOrigin("file:///etc/passwd")).toThrow("Origin must use"));
});

describe("hostname validation", () => {
  it("normalizes a URL-like hostname", () => expect(validateHostname("HTTPS://Preview.Example.com/")).toBe("preview.example.com"));
  it("rejects a single label", () => expect(() => validateHostname("localhost")).toThrow("valid hostname"));
  it("builds a hostname from one label and the configured domain", () => expect(hostnameFromSubdomain("Preview", "bugthedebugger.com")).toBe("preview.bugthedebugger.com"));
  it("rejects a full hostname where one label is expected", () => expect(() => hostnameFromSubdomain("preview.example.com", "bugthedebugger.com")).toThrow("one subdomain label"));
});

describe("slug", () => {
  it("creates a cloudflared-safe name", () => expect(slug("Docs Preview! 2026")).toBe("docs-preview-2026"));
});

describe("expiration duration", () => {
  it("parses agent-friendly durations", () => {
    expect(parseDuration("15m")).toBe(900);
    expect(parseDuration("4h")).toBe(14_400);
    expect(parseDuration("1d")).toBe(86_400);
  });
  it("rejects unsafe ranges", () => expect(() => parseDuration("90d")).toThrow("between 1 minute and 30 days"));
  it("normalizes an exact time and rejects past times", () => {
    const now = Date.parse("2026-08-15T12:00:00.000Z");
    expect(parseExpirationTime("2026-08-15T13:00:00Z", now)).toBe("2026-08-15T13:00:00.000Z");
    expect(() => parseExpirationTime("2026-08-15T11:00:00Z", now)).toThrow("future");
  });
});

describe("tunnel metadata", () => {
  it("requires a name and description for quick and named links", () => {
    expect(() => quickInputSchema.parse({ name: "Preview", description: "", origin: "3000", expiresInSeconds: 300 })).toThrow("Description is required");
    expect(() => namedInputSchema.parse({ name: "", description: "Docs for review", origin: "3000" })).toThrow();
  });
  it("requires every quick share to have exactly one expiration policy", () => {
    const input = { name: "Preview", description: "Client review", origin: "3000" };
    expect(() => quickInputSchema.parse(input)).toThrow("require either a duration or an exact expiration time");
    expect(() => quickInputSchema.parse({ ...input, expiresInSeconds: 300, expiresAt: "2099-01-01T00:00:00.000Z" })).toThrow();
    expect(quickInputSchema.parse({ ...input, expiresInSeconds: 300 }).expiresInSeconds).toBe(300);
  });
  it("protects file shares by default while allowing an explicit public share", () => {
    const input = { name: "File", description: "Private file", path: "/tmp/file.html", expiresInSeconds: 300 };
    expect(fileQuickInputSchema.parse(input).tokenRequired).toBe(true);
    expect(fileQuickInputSchema.parse({ ...input, tokenRequired: false }).tokenRequired).toBe(false);
  });
});
