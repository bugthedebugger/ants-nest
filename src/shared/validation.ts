export function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  const candidate = /^\d{1,5}$/.test(trimmed) ? `http://localhost:${trimmed}` : trimmed;
  let url: URL;
  try {
    url = new URL(candidate.includes("://") ? candidate : `http://${candidate}`);
  } catch {
    throw new Error(`Invalid origin: ${value}`);
  }
  if (!["http:", "https:", "tcp:", "ssh:", "rdp:"].includes(url.protocol)) {
    throw new Error("Origin must use http, https, tcp, ssh, or rdp");
  }
  if (!url.hostname) throw new Error("Origin needs a hostname");
  return url.toString().replace(/\/$/, "");
}

export function validateHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (hostname.length > 253 || !/^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
    throw new Error("Enter a valid hostname, for example preview.example.com");
  }
  return hostname;
}

export function slug(value: string): string {
  const result = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return result || "tunnel";
}
