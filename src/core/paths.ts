import os from "node:os";
import path from "node:path";

export function dataDirectory(): string {
  return process.env.ANTS_NEST_HOME || path.join(os.homedir(), ".ants-nest");
}

export function cloudflareDirectory(): string {
  return process.env.CLOUDFLARED_CONFIG_DIR || path.join(os.homedir(), ".cloudflared");
}

export const paths = {
  database: () => path.join(dataDirectory(), "state.sqlite"),
  logs: () => path.join(dataDirectory(), "logs"),
  cloudflareConfig: () => path.join(dataDirectory(), "cloudflare.json"),
  tokens: () => path.join(dataDirectory(), "tokens"),
  shares: () => path.join(dataDirectory(), "shares"),
  cloudflaredBinary: () => path.join(dataDirectory(), "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared"),
  cloudflaredMetadata: () => path.join(dataDirectory(), "bin", "cloudflared.json"),
};
