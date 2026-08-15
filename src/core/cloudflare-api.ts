import fs from "node:fs/promises";
import path from "node:path";
import { cloudflareSetupSchema, type CloudflareSetupInput } from "../shared/types";
import { validateHostname } from "../shared/validation";
import { paths } from "./paths";

const endpoint = "https://api.cloudflare.com/client/v4";

type CloudflareEnvelope<T> = { success: boolean; result: T; errors?: Array<{ code?: number; message?: string }> };

function fromEnvironment(): CloudflareSetupInput | undefined {
  const values = {
    proxyDomain: process.env.CLOUDFLARE_PROXY_DOMAIN,
    zoneId: process.env.CLOUDFLARE_ZONE_ID,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  };
  if (!Object.values(values).every(Boolean)) return undefined;
  return cloudflareSetupSchema.parse(values);
}

export async function readCloudflareConfig(): Promise<CloudflareSetupInput | undefined> {
  const environment = fromEnvironment();
  if (environment) return environment;
  try {
    return cloudflareSetupSchema.parse(JSON.parse(await fs.readFile(paths.cloudflareConfig(), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read Cloudflare configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function request<T>(config: CloudflareSetupInput, apiPath: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${endpoint}${apiPath}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json", ...init.headers },
  });
  const envelope = await response.json().catch(() => undefined) as CloudflareEnvelope<T> | undefined;
  if (!response.ok || !envelope?.success) {
    const detail = envelope?.errors?.map((error) => error.message || `Cloudflare error ${error.code}`).join("; ");
    throw new Error(detail || `Cloudflare API request failed (${response.status})`);
  }
  return envelope.result;
}

export async function verifyCloudflareConfig(input: CloudflareSetupInput): Promise<CloudflareSetupInput> {
  const config = cloudflareSetupSchema.parse({ ...input, proxyDomain: validateHostname(input.proxyDomain) });
  await Promise.all([
    request(config, `/accounts/${config.accountId}/cfd_tunnel?per_page=1`),
    request(config, `/zones/${config.zoneId}/dns_records?per_page=1`),
  ]);
  return config;
}

export async function saveCloudflareConfig(input: CloudflareSetupInput): Promise<CloudflareSetupInput> {
  const config = await verifyCloudflareConfig(input);
  await fs.mkdir(path.dirname(paths.cloudflareConfig()), { recursive: true, mode: 0o700 });
  const temporary = `${paths.cloudflareConfig()}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, paths.cloudflareConfig());
  return config;
}

export async function configureFromEnvironment() {
  const config = fromEnvironment();
  if (!config) throw new Error("Set CLOUDFLARE_PROXY_DOMAIN, CLOUDFLARE_ZONE_ID, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN");
  return saveCloudflareConfig(config);
}

export async function createManagedTunnel(input: { id: string; name: string; hostname: string; origin: string }) {
  const config = await readCloudflareConfig();
  if (!config) throw new Error("Cloudflare API configuration is missing. Complete Setup first.");
  const hostname = validateHostname(input.hostname);
  if (hostname !== config.proxyDomain && !hostname.endsWith(`.${config.proxyDomain}`)) {
    throw new Error(`Hostname must be ${config.proxyDomain} or a subdomain of it`);
  }
  const existingRecords = await request<Array<{ id: string; type: string }>>(
    config,
    `/zones/${config.zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
  );
  if (existingRecords.length) {
    const types = [...new Set(existingRecords.map((record) => record.type))].sort().join(", ");
    throw new Error(`Hostname ${hostname} is already in use by Cloudflare DNS${types ? ` (${types})` : ""}. Choose an unused hostname.`);
  }
  let tunnelId: string | undefined;
  let dnsRecordId: string | undefined;
  try {
    const tunnel = await request<{ id: string; token?: string }>(config, `/accounts/${config.accountId}/cfd_tunnel`, {
      method: "POST", body: JSON.stringify({ name: input.name, config_src: "cloudflare" }),
    });
    tunnelId = tunnel.id;
    await request(config, `/accounts/${config.accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      method: "PUT", body: JSON.stringify({ config: { ingress: [{ hostname, service: input.origin }, { service: "http_status:404" }] } }),
    });
    const dnsBody = JSON.stringify({ type: "CNAME", name: hostname, content: `${tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1, comment: "Managed by Ants Nest" });
    const dnsRecord = await request<{ id: string }>(config, `/zones/${config.zoneId}/dns_records`, { method: "POST", body: dnsBody });
    dnsRecordId = dnsRecord.id;
    const token = tunnel.token || await request<string>(config, `/accounts/${config.accountId}/cfd_tunnel/${tunnelId}/token`);
    await fs.mkdir(paths.tokens(), { recursive: true, mode: 0o700 });
    const tokenFile = path.join(paths.tokens(), `${input.id}.token`);
    await fs.writeFile(tokenFile, token, { mode: 0o600 });
    return { tunnelId, dnsRecordId, tokenFile, hostname };
  } catch (error) {
    if (dnsRecordId) await request(config, `/zones/${config.zoneId}/dns_records/${dnsRecordId}`, { method: "DELETE" }).catch(() => undefined);
    if (tunnelId) await request(config, `/accounts/${config.accountId}/cfd_tunnel/${tunnelId}`, { method: "DELETE" }).catch(() => undefined);
    throw error;
  }
}

export async function deleteManagedTunnel(input: { tunnelId: string; hostname: string; dnsRecordId?: string | undefined }) {
  const config = await readCloudflareConfig();
  if (!config) throw new Error("Cloudflare API configuration is missing. Cannot release the named hostname.");
  const hostname = validateHostname(input.hostname);
  const records = await request<Array<{ id: string; type: string; content?: string; comment?: string }>>(
    config,
    `/zones/${config.zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
  );
  const expectedContent = `${input.tunnelId}.cfargotunnel.com`;
  const owned = records.find((record) =>
    record.type === "CNAME" && record.content?.toLowerCase().replace(/\.$/, "") === expectedContent &&
    (record.id === input.dnsRecordId || (!input.dnsRecordId && record.comment === "Managed by Ants Nest")),
  );
  if (records.length && !owned) {
    throw new Error(`Refusing to release ${hostname}: its DNS record is not owned by this Ants Nest tunnel.`);
  }
  if (owned) await request(config, `/zones/${config.zoneId}/dns_records/${owned.id}`, { method: "DELETE" });
  await request(config, `/accounts/${config.accountId}/cfd_tunnel/${input.tunnelId}`, { method: "DELETE" });
}
