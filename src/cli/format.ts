import { formatRemaining } from "../shared/duration";
import type { TunnelView } from "../shared/types";

function truncate(value: string, width: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= width) return normalized;
  if (width <= 1) return "…";
  return `${normalized.slice(0, width - 1)}…`;
}

function line(label: string, value: string, width: number) {
  const prefix = `  ${label.padEnd(7)} `;
  return `${prefix}${truncate(value, Math.max(1, width - prefix.length))}`;
}

export function formatTunnelList(tunnels: TunnelView[], columns = process.stdout.columns || 80) {
  const width = Math.max(32, columns);
  return tunnels.map((tunnel) => {
    const access = tunnel.sharedPath ? tunnel.tokenRequired === false ? "public" : "token" : "service";
    const expiry = formatRemaining(tunnel.expiresAt) || "no expiry";
    const headingPrefix = tunnel.status === "online" ? "●" : tunnel.status === "failed" ? "×" : "○";
    const heading = truncate(`${headingPrefix} ${tunnel.status.toUpperCase()}  ${tunnel.name}`, width);
    const metadata = `${tunnel.id.slice(0, 8)} · ${tunnel.kind} · ${access} · ${expiry}`;
    const rows = [heading, `  ${truncate(metadata, width - 2)}`];
    if (tunnel.description) rows.push(line("About", tunnel.description, width));
    rows.push(line("Source", tunnel.sharedPath || tunnel.origin, width));
    if (tunnel.publicUrl) rows.push(line("URL", tunnel.publicUrl, width));
    if (tunnel.error) rows.push(line("Error", tunnel.error, width));
    return rows.join("\n");
  }).join("\n\n");
}
