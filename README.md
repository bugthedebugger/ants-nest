# Ants Nest

Ants Nest is a local-first Electron app and CLI for creating Cloudflare Tunnel links. The desktop dashboard and the `ants` CLI share one state store, so a coding agent can publish a local service and you can see or stop it from the app.

There is no Ants Nest account and no hosted backend. Cloudflare Setup installs `cloudflared` into Ants Nest's private data directory.

## What it supports

- **Quick shares** — expiring `<name>-quick.<domain>` links on your own domain.
- **Named tunnels** — stable `<name>-share.<domain>` links created through the Cloudflare API, with no interactive browser login.
- **Agent-friendly CLI** — JSON output, deterministic exit codes, port shorthand, shared status and logs.
- **Phone access** — a responsive browser dashboard at `antsnest.<domain>`, with QR pairing and no separate app.
- **Safe process boundary** — Electron's renderer is sandboxed and talks to a narrow typed preload bridge. All `cloudflared` arguments use direct process spawning, never a shell.
- **Persistent tunnel processes** — links remain online after the CLI exits or the desktop window closes.

The project follows the architectural cues of [T3 Code](https://github.com/pingdotgg/t3code): a desktop host process, isolated renderer bridge, reusable core services, a first-class CLI, typed contracts, and local ownership of credentials/data.

## Requirements

- Node.js 22+

`cloudflared` is an application dependency, not a manual prerequisite. The one-time Setup flow fetches Cloudflare's current official release for the platform and verifies its published SHA-256 digest before installation. The binary is shared by the Electron app and CLI.

## Develop

```bash
npm install
npm run dev
```

Build and validate everything:

```bash
npm run check
npm run package
```

`npm run package` produces the platform installer under `release/`.

## Install the CLI for agents

During development:

```bash
npm run build
npm link
ants doctor
```

Quickly expose port 3000:

```bash
ants share 3000 --name "Local app" --description "Development build for the checkout flow" --expires 15m
ants share 3000 --name "Local app" --description "One-hour client review" --expires 1h
ants share 3000 --name "Local app" --description "Review before the scheduled cutoff" --expires-at "2026-08-16T17:30:00+05:45"
```

Every Quick Share requires an expiration. Its display name becomes a URL-safe hostname such as `local-app-quick.example.com`. It accepts `m`, `h`, or `d` durations from one minute through 30 days, or an exact date and time with `--expires-at`. Values without an explicit timezone use the computer's local timezone; ISO offsets are recommended for agents. The desktop and phone quick-share forms include local date/time pickers. A detached watchdog enforces the deadline even after the creating CLI or Electron app exits.

Machine-readable output:

```bash
ants share http://localhost:5173 \
  --name "UI preview" \
  --description "Current dashboard redesign for mobile review" \
  --expires 1h \
  --json
```

The JSON object includes `publicUrl`, `pid`, `status`, and the profile ID. Agents can manage it later:

```bash
ants list --json
ants stop "UI preview"
ants start "UI preview" --json
ants logs "UI preview"
ants remove "UI preview"
```

The CLI is intentionally agent-safe and always reserves its namespace: quick shares become `<name>-quick.<domain>` and named tunnels become `<name>-share.<domain>`. The Electron and paired-phone forms are user-controlled instead: enter any unused first-level hostname such as `review.example.com` or `docs.example.com`. Every interface refuses occupied DNS records and never replaces them.

## One-time Cloudflare setup

```bash
export CLOUDFLARE_PROXY_DOMAIN="tunnels.example.com"
export CLOUDFLARE_ZONE_ID="..."
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_API_TOKEN="..."
ants setup
```

Running `ants configure` (an alias of `ants setup`) without complete environment variables opens an interactive wizard; API-token input is masked. For non-interactive automation, keep identifiers in flags or environment variables and pipe the secret through stdin:

```bash
printf '%s' "$CLOUDFLARE_API_TOKEN" | ants configure \
  --proxy-domain tunnels.example.com \
  --zone-id "$CLOUDFLARE_ZONE_ID" \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --api-token-stdin \
  --json
```

The CLI also accepts `--api-token`, but stdin or the environment variable is recommended because command arguments can be visible in shell history and process listings. Successful configuration output never includes the API token.

You can enter the same four values in the desktop Setup panel. The token needs **Cloudflare Tunnel: Edit** for the account and **DNS: Edit** for the zone. Ants Nest validates access before saving the configuration. Then:

```bash
ants create docs-preview \
  --description "Stable documentation preview for the product team" \
  --url http://localhost:3000 \
  --expires 4h \
  --json
```

With `CLOUDFLARE_PROXY_DOMAIN=example.com`, that command publishes `docs-preview-share.example.com`. Quick shares use `<name>-quick.example.com`, and phone access uses the fixed `antsnest.example.com` hostname. All three patterns are first-level subdomains covered by Cloudflare Universal SSL on a full zone, so Advanced Certificate Manager is not required.

Ants Nest creates remotely managed tunnels through the API, uploads ingress configuration, creates proxied CNAME records, stores connector tokens in user-only files, and starts `cloudflared` with `--token-file`. Stopping, removing, or expiring a share stops its connector, deletes its owned DNS record and Cloudflare Tunnel, removes its connector token, and releases the hostname.
Ants Nest refuses provisioning if the exact hostname already has any Cloudflare DNS record. It never replaces an existing record; choose a different name or release the existing owner first.

## Control tunnels from your phone

Keep the desktop app open and select **Enable phone access**. Ants Nest starts a web dashboard on a random loopback-only port, exposes it at `antsnest.<domain>`, and displays a QR code. Scan it with your phone to:

- open any active public link;
- start and stop saved tunnels;
- create a new quick share with a required name and description.

The pairing URL carries a random 256-bit, single-use credential after the URL fragment (`#`). Browser fragments are not sent in HTTP requests, so Cloudflare and HTTP access logs never receive it. The browser exchanges that credential once for its own unique device token and stores the device token locally. The server uses constant-time token comparison, has no CORS allowance, limits request body size, and binds only to `127.0.0.1`.

The desktop pairing panel lists every authorized browser with its last-active time. You can revoke one device or all devices immediately. Revocation also invalidates any outstanding unused QR code, so a removed browser must receive a newly generated pairing code before it can return. Pairing codes cannot be reused after a successful exchange.

Anyone holding an unused pairing link can authorize one browser. Use **End access** when finished; this stops the control tunnel, shuts down the local web server, and invalidates every device and pairing token. Normal desktop shutdown also ends phone access.

## Local data

Tunnel state lives in the WAL-enabled SQLite database `~/.ants-nest/state.sqlite`. API configuration, connector tokens, and logs also live under `~/.ants-nest`. Override that location with `ANTS_NEST_HOME` and override the executable with `CLOUDFLARED_BIN`. The four `CLOUDFLARE_*` environment variables take precedence over the saved configuration.

SQLite transactions coordinate concurrent Electron and CLI updates. A user-only local socket signals committed changes to an open Electron process, so CLI changes refresh the dashboard immediately without polling a JSON file.

## Security notes

- The Cloudflare API token is stored locally in `~/.ants-nest/cloudflare.json` with user-only permissions. It is never sent to the renderer after setup or passed to `cloudflared`.
- Connector tokens are stored separately with user-only permissions and passed through `cloudflared --token-file`, avoiding secrets in process arguments.
- A public tunnel exposes the configured local service to the Internet. Stop it when the share is finished.
- Phone access is capability-based: treat its full pairing URL like a temporary password.
- CLI arguments are passed as an argument array with `shell: false`.
- Logs and state are created with user-only permissions where supported.
