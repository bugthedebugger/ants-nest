#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import packageMetadata from "../../package.json";
import { requestAppControl } from "../core/app-control";
import { checkCliUpdate, runCliUpdate } from "../core/cli-update";
import { createUpdateProgressReporter } from "./update-progress";
import { configureCloudflare, createFileNamed, createFileQuick, createNamed, createQuick, doctor, listTunnels, removeTunnel, startTunnel, stopTunnel, tunnelLogs } from "../core/manager";
import { parseDuration, parseExpirationTime } from "../shared/duration";
import type { CloudflareSetupInput, RemoteAccessState } from "../shared/types";
import { formatTunnelList } from "./format";

const program = new Command();
program.name("ants-nest").description("Create and manage Cloudflare Tunnel share links").version(packageMetadata.version);

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

async function pairingOutput(state: RemoteAccessState, json?: boolean) {
  if (!state.pairingUrl) throw new Error("Ants Nest did not return a pairing URL");
  const qr = await QRCode.toString(state.pairingUrl, { type: "terminal", small: true, errorCorrectionLevel: "M" });
  if (json) return output({ publicUrl: state.publicUrl, pairingUrl: state.pairingUrl, qr, devices: state.devices }, true);
  console.log(`Pairing URL:\n${state.pairingUrl}\n\n${qr}\nSingle-use: this link expires after the first successful device pairing.`);
}

function remoteStatusOutput(state: RemoteAccessState, json?: boolean) {
  if (json) return output(state, true);
  console.log(`Remote access: ${state.enabled ? "enabled" : "disabled"}`);
  if (state.publicUrl) console.log(`URL: ${state.publicUrl}`);
  if (!state.devices.length) return console.log("Authorized devices: none");
  console.log("Authorized devices:");
  console.table(state.devices.map((device) => ({ id: device.id, name: device.name, created: device.createdAt, lastSeen: device.lastSeenAt })));
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
  .description("Share a local service, file, or folder with automatic expiration")
  .argument("[origin-or-path]", "port, origin URL, or existing file/folder", "3000")
  .requiredOption("-n, --name <name>", "display name")
  .requiredOption("-d, --description <description>", "what this link exposes")
  .option("-e, --expires <duration>", "automatically stop after 15m, 1h, 4h, or 1d")
  .option("--expires-at <date-time>", "stop at an exact ISO or local date-time")
  .option("--path <path>", "share this file or folder using Ants Nest's built-in server")
  .option("--no-token", "make a file/folder share public without token verification")
  .option("--json", "machine-readable output")
  .action((originOrPath, options) => wrap(async () => {
    if (options.expires && options.expiresAt) throw new Error("Use either --expires or --expires-at, not both");
    if (!options.expires && !options.expiresAt) throw new Error("Quick shares require --expires <duration> or --expires-at <date-time>");
    const expiration = { ...(options.expires ? { expiresInSeconds: parseDuration(options.expires) } : {}), ...(options.expiresAt ? { expiresAt: parseExpirationTime(options.expiresAt) } : {}) };
    const explicitPath = options.path ? path.resolve(options.path) : undefined;
    const positionalPath = !options.path && await fs.stat(path.resolve(originOrPath)).then((stat) => stat.isFile() || stat.isDirectory()).catch(() => false) ? path.resolve(originOrPath) : undefined;
    const tunnel = explicitPath || positionalPath
      ? await createFileQuick({ name: options.name, description: options.description, path: explicitPath || positionalPath!, tokenRequired: options.token, ...expiration })
      : await createQuick({ name: options.name, description: options.description, origin: originOrPath, ...expiration });
    output(options.json ? tunnel : tunnel.publicUrl || tunnel, options.json);
  }));
program.command("create")
  .description("Create a persistent link for a local service, file, or folder (expiration optional)")
  .argument("<name>")
  .requiredOption("-d, --description <description>", "what this hostname exposes")
  .option("-u, --url <origin>", "local port or URL")
  .option("--path <path>", "share this file or folder using Ants Nest's built-in server")
  .option("--no-token", "make a file/folder share public without token verification")
  .option("-e, --expires <duration>", "release the hostname after 15m, 1h, 4h, or 1d")
  .option("--expires-at <date-time>", "release the hostname at an exact ISO or local date-time")
  .option("--json")
  .action((name, options) => wrap(async () => {
    if (options.expires && options.expiresAt) throw new Error("Use either --expires or --expires-at, not both");
    if (Boolean(options.url) === Boolean(options.path)) throw new Error("Use exactly one of --url <origin> or --path <file-or-folder>");
    const expiration = { ...(options.expires ? { expiresInSeconds: parseDuration(options.expires) } : {}), ...(options.expiresAt ? { expiresAt: parseExpirationTime(options.expiresAt) } : {}) };
    const tunnel = options.path
      ? await createFileNamed({ name, description: options.description, path: path.resolve(options.path), tokenRequired: options.token, ...expiration })
      : await createNamed({ name, description: options.description, origin: options.url, ...expiration });
    output(tunnel, options.json);
  }));
program.command("list").alias("ls").description("List tunnel profiles and live status").option("--json").action((options) => wrap(async () => {
  const tunnels = await listTunnels();
  if (options.json) return output(tunnels, true);
  if (!tunnels.length) return output("No tunnels yet. Try: ants share 3000");
  output(formatTunnelList(tunnels));
}));
program.command("start").argument("<id-or-name>").option("--json").action((id, options) => wrap(async () => output(await startTunnel(id), options.json)));
program.command("stop").argument("<id-or-name>").description("Stop a Quick Share or permanently release a Named Tunnel").option("--json").action((id, options) => wrap(async () => output(await stopTunnel(id), options.json)));
program.command("remove").alias("rm").argument("<id-or-name>").description("Remove a Quick Share or permanently release a Named Tunnel and its hostname").action((id) => wrap(async () => { await removeTunnel(id); output(`Removed ${id}`); }));
program.command("logs").argument("<id-or-name>").action((id) => wrap(async () => output(await tunnelLogs(id))));

program.command("update")
  .description("Update the ants CLI to the latest GitHub release")
  .option("--check", "report whether an update is available without installing it")
  .option("--force", "reinstall even when already up to date")
  .option("--json", "machine-readable output")
  .action((options) => wrap(async () => {
    const { release, updateAvailable } = await checkCliUpdate(packageMetadata.version);
    if (options.check || (!updateAvailable && !options.force)) {
      const status = { currentVersion: packageMetadata.version, latestVersion: release.version, updateAvailable };
      if (options.json) return output(status, true);
      return output(updateAvailable
        ? `Update available: v${packageMetadata.version} → v${release.version}. Run \`ants update\` to install.`
        : `Already up to date (v${packageMetadata.version}).`);
    }
    const progress = options.json ? undefined : createUpdateProgressReporter();
    const result = await runCliUpdate({
      currentVersion: packageMetadata.version,
      force: options.force,
      release,
      ...(progress ? { onProgress: progress.report } : {}),
    }).finally(() => progress?.finish());
    if (options.json) return output(result, true);
    if (!result.updated) return output(result.reason ?? "No update was installed.");
    output(`Updated ants CLI v${result.currentVersion} → v${result.latestVersion}`);
  }));

const remote = program.command("remote").description("Manage Remote access through the running Ants Nest desktop app");
remote.command("status").description("Show the Remote access URL and authorized devices").option("--json").action((options) => wrap(async () => {
  remoteStatusOutput(await requestAppControl({ operation: "remote-status" }), options.json);
}));
remote.command("enable").description("Enable Remote access").option("--json").action((options) => wrap(async () => {
  const state = await requestAppControl({ operation: "remote-enable" });
  if (options.json) return output(state, true);
  remoteStatusOutput(state);
  if (state.pairingUrl) await pairingOutput(state);
  else console.log("Run `ants remote pair` to authorize another device.");
}));
remote.command("pair").description("Create a single-use device pairing URL and terminal QR code").option("--json").action((options) => wrap(async () => {
  await pairingOutput(await requestAppControl({ operation: "remote-pair" }), options.json);
}));
remote.command("revoke").description("Revoke one authorized device").argument("<device-id>").option("--json").action((deviceId, options) => wrap(async () => {
  const state = await requestAppControl({ operation: "remote-revoke", deviceId });
  if (options.json) output(state, true);
  else console.log(`Revoked device ${deviceId}`);
}));
remote.command("revoke-all").description("Revoke every authorized device").option("--json").action((options) => wrap(async () => {
  const state = await requestAppControl({ operation: "remote-revoke-all" });
  if (options.json) output(state, true);
  else console.log("Revoked all authorized devices");
}));
remote.command("disable").description("End Remote access and release its hostname").option("--json").action((options) => wrap(async () => {
  const state = await requestAppControl({ operation: "remote-disable" });
  if (options.json) output(state, true);
  else console.log("Remote access disabled");
}));

export const cliCompletion = process.env.ANTS_NEST_FILE_SHARE_WORKER_CONFIG
  ? import("../core/file-share-server").then(({ runFileShareWorker }) => runFileShareWorker(process.env.ANTS_NEST_FILE_SHARE_WORKER_CONFIG!))
  : program.parseAsync();
