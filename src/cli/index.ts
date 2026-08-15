#!/usr/bin/env node
import { Command } from "commander";
import { configureCloudflare, createNamed, createQuick, doctor, listTunnels, removeTunnel, startTunnel, stopTunnel, tunnelLogs } from "../core/manager";
import { formatRemaining, parseDuration, parseExpirationTime } from "../shared/duration";
import type { CloudflareSetupInput } from "../shared/types";

const program = new Command();
program.name("ants-nest").description("Create and manage Cloudflare Tunnel share links").version("0.1.0");

function output(value: unknown, json?: boolean) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === "string") console.log(value);
  else console.log(value);
}

function wrap(action: () => Promise<void>) {
  return action().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function readStdinSecret(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (!value) throw new Error("No API token was received on stdin");
  return value;
}

async function hiddenPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Interactive token entry needs a TTY. Use CLOUDFLARE_API_TOKEN or --api-token-stdin.");
  }
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") { cleanup(); reject(new Error("Setup cancelled")); return; }
        if (character === "\r" || character === "\n") { cleanup(); resolve(value); return; }
        if (character === "\u007f" || character === "\b") {
          if (value) { value = value.slice(0, -1); process.stdout.write("\b \b"); }
        } else { value += character; process.stdout.write("•"); }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function interactiveSetup(defaults: Partial<CloudflareSetupInput>): Promise<CloudflareSetupInput> {
  if (!process.stdin.isTTY) throw new Error("Missing Cloudflare values. Set the four CLOUDFLARE_* variables or pass setup options.");
  const { createInterface } = await import("node:readline/promises");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (label: string, fallback?: string) => {
    const answer = (await readline.question(`${label}${fallback ? ` [${fallback}]` : ""}: `)).trim();
    return answer || fallback || "";
  };
  const proxyDomain = await ask("CLOUDFLARE_PROXY_DOMAIN", defaults.proxyDomain);
  const zoneId = await ask("CLOUDFLARE_ZONE_ID", defaults.zoneId);
  const accountId = await ask("CLOUDFLARE_ACCOUNT_ID", defaults.accountId);
  readline.close();
  const apiToken = defaults.apiToken || await hiddenPrompt("CLOUDFLARE_API_TOKEN (hidden): ");
  return { proxyDomain, zoneId, accountId, apiToken };
}

program.command("doctor").description("Check cloudflared installation and authentication").option("--json").action((options) => wrap(async () => output(await doctor(), options.json)));
program.command("setup").alias("configure").description("Install cloudflared, then validate and save Cloudflare API configuration")
  .option("--proxy-domain <domain>").option("--zone-id <id>").option("--account-id <id>").option("--api-token <token>")
  .option("--api-token-stdin", "read the API token from stdin without exposing it in process arguments")
  .option("--json", "machine-readable status output")
  .action((options) => wrap(async () => {
    if (options.apiToken && options.apiTokenStdin) throw new Error("Use either --api-token or --api-token-stdin, not both");
    const environment: Partial<CloudflareSetupInput> = {
      ...(process.env.CLOUDFLARE_PROXY_DOMAIN ? { proxyDomain: process.env.CLOUDFLARE_PROXY_DOMAIN } : {}),
      ...(process.env.CLOUDFLARE_ZONE_ID ? { zoneId: process.env.CLOUDFLARE_ZONE_ID } : {}),
      ...(process.env.CLOUDFLARE_ACCOUNT_ID ? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID } : {}),
      ...(process.env.CLOUDFLARE_API_TOKEN ? { apiToken: process.env.CLOUDFLARE_API_TOKEN } : {}),
    };
    const provided: Partial<CloudflareSetupInput> = {
      ...environment,
      ...(options.proxyDomain ? { proxyDomain: options.proxyDomain } : {}),
      ...(options.zoneId ? { zoneId: options.zoneId } : {}),
      ...(options.accountId ? { accountId: options.accountId } : {}),
      ...(options.apiToken ? { apiToken: options.apiToken } : {}),
      ...(options.apiTokenStdin ? { apiToken: await readStdinSecret() } : {}),
    };
    const complete = provided.proxyDomain && provided.zoneId && provided.accountId && provided.apiToken;
    const input = complete ? provided as CloudflareSetupInput : await interactiveSetup(provided);
    const result = await configureCloudflare(input);
    output(result, options.json);
  }));
program.command("share")
  .description("Create an expiring <name>-quick.<domain> link")
  .argument("[origin]", "port or origin URL", "3000")
  .requiredOption("-n, --name <name>", "display name")
  .requiredOption("-d, --description <description>", "what this link exposes")
  .option("-e, --expires <duration>", "automatically stop after 15m, 1h, 4h, or 1d")
  .option("--expires-at <date-time>", "stop at an exact ISO or local date-time")
  .option("--json", "machine-readable output")
  .action((origin, options) => wrap(async () => {
    if (options.expires && options.expiresAt) throw new Error("Use either --expires or --expires-at, not both");
    if (!options.expires && !options.expiresAt) throw new Error("Quick shares require --expires <duration> or --expires-at <date-time>");
    const tunnel = await createQuick({ name: options.name, description: options.description, origin, ...(options.expires ? { expiresInSeconds: parseDuration(options.expires) } : {}), ...(options.expiresAt ? { expiresAt: parseExpirationTime(options.expiresAt) } : {}) });
    output(options.json ? tunnel : tunnel.publicUrl || tunnel, options.json);
  }));
program.command("create")
  .description("Create and start a <name>-share.<domain> tunnel")
  .argument("<name>")
  .requiredOption("-d, --description <description>", "what this hostname exposes")
  .requiredOption("-u, --url <origin>", "local port or URL")
  .option("-e, --expires <duration>", "release the hostname after 15m, 1h, 4h, or 1d")
  .option("--expires-at <date-time>", "release the hostname at an exact ISO or local date-time")
  .option("--json")
  .action((name, options) => wrap(async () => {
    if (options.expires && options.expiresAt) throw new Error("Use either --expires or --expires-at, not both");
    output(await createNamed({ name, description: options.description, origin: options.url, ...(options.expires ? { expiresInSeconds: parseDuration(options.expires) } : {}), ...(options.expiresAt ? { expiresAt: parseExpirationTime(options.expiresAt) } : {}) }), options.json);
  }));
program.command("list").alias("ls").description("List tunnel profiles and live status").option("--json").action((options) => wrap(async () => {
  const tunnels = await listTunnels();
  if (options.json) return output(tunnels, true);
  if (!tunnels.length) return output("No tunnels yet. Try: ants share 3000");
  console.table(tunnels.map(({ id, name, description, kind, origin, status, publicUrl, expiresAt }) => ({ id: id.slice(0, 8), name, description, kind, origin, status, expires: formatRemaining(expiresAt) || "—", url: publicUrl || "—" })));
}));
program.command("start").argument("<id-or-name>").option("--json").action((id, options) => wrap(async () => output(await startTunnel(id), options.json)));
program.command("stop").argument("<id-or-name>").description("Stop a Quick Share or permanently release a Named Tunnel").option("--json").action((id, options) => wrap(async () => output(await stopTunnel(id), options.json)));
program.command("remove").alias("rm").argument("<id-or-name>").description("Remove a Quick Share or permanently release a Named Tunnel and its hostname").action((id) => wrap(async () => { await removeTunnel(id); output(`Removed ${id}`); }));
program.command("logs").argument("<id-or-name>").action((id) => wrap(async () => output(await tunnelLogs(id))));

program.parseAsync();
