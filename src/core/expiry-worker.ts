#!/usr/bin/env node
import { expireTunnel } from "./manager";

const profileId = process.argv[2];
const expiresAt = process.argv[3];

if (!profileId || !expiresAt || !Number.isFinite(new Date(expiresAt).getTime())) process.exit(2);

async function waitUntil(timestamp: number) {
  while (Date.now() < timestamp) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(timestamp - Date.now(), 60_000)));
  }
}

void (async () => {
  await waitUntil(new Date(expiresAt).getTime());
  await expireTunnel(profileId, expiresAt).catch(() => undefined);
})();
