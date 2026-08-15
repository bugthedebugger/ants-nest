const units: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

export function parseDuration(value: string): number {
  const match = value.trim().toLowerCase().match(/^(\d+)(s|m|h|d)$/);
  if (!match?.[1] || !match[2]) throw new Error("Expiration must look like 15m, 1h, 4h, or 1d");
  const seconds = Number(match[1]) * units[match[2]]!;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 2_592_000) throw new Error("Expiration must be between 1 minute and 30 days");
  return seconds;
}

export function parseExpirationTime(value: string, now = Date.now()): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Expiration time must be a valid ISO date or local date-time");
  if (timestamp <= now) throw new Error("Expiration time must be in the future");
  if (timestamp - now > 2_592_000_000) throw new Error("Expiration time cannot be more than 30 days away");
  return new Date(timestamp).toISOString();
}

export function formatRemaining(expiresAt?: string): string | undefined {
  if (!expiresAt) return undefined;
  const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.ceil(seconds / 3600)}h`;
  return `${Math.ceil(seconds / 86400)}d`;
}
