# Ants Nest

Ants Nest is a local-first Electron app and CLI for publishing local services through Cloudflare Tunnel. It gives humans a desktop and phone dashboard while giving coding agents a predictable, JSON-friendly command line.

There is no Ants Nest account or hosted backend. The desktop app, CLI, Cloudflare credentials, tunnel state, and authorized-device state all live on your machine.

## Highlights

- Create expiring quick shares and longer-lived named tunnels.
- Use any available first-level hostname from the Electron or paired-phone UI.
- Give agents collision-safe CLI namespaces: `<name>-quick.<domain>` and `<name>-share.<domain>`.
- Control tunnels from a phone through `antsnest.<domain>` with single-use QR pairing.
- Revoke individual phone browsers or every authorized device immediately.
- Configure Cloudflare once from either the desktop app or CLI.
- Share one WAL-enabled SQLite state store between Electron and the CLI, with real-time desktop refresh.
- Install and update the official `cloudflared` binary during setup after SHA-256 verification.
- Never replace an existing DNS record.

## How hostnames work

Assuming `CLOUDFLARE_PROXY_DOMAIN=example.com`:

| Surface | Quick share | Named tunnel |
| --- | --- | --- |
| Electron / phone | User chooses an unused direct subdomain, such as `review.example.com` | User chooses an unused direct subdomain, such as `docs.example.com` |
| CLI / agents | `<slug>-quick.example.com` | `<slug>-share.example.com` |
| Phone dashboard | `antsnest.example.com` | — |

These are first-level subdomains, so a normal full Cloudflare zone can serve them with Universal SSL. Ants Nest checks the exact hostname before provisioning and refuses to continue if any DNS record already occupies it. There is no replace or override option.

Stopping, removing, or expiring a managed share terminates its connector, deletes the DNS record and Cloudflare Tunnel owned by Ants Nest, removes its connector token, and releases the hostname. Treat `stop` as terminal for that share; create a new one if it is needed again.

## Requirements

- Node.js 22 or newer for development and CLI use.
- A Cloudflare zone and an API token with:
  - Account → Cloudflare Tunnel → Edit
  - Zone → DNS → Edit

You do not need to install `cloudflared` manually. Setup downloads the current official binary into Ants Nest's private data directory and verifies its published SHA-256 digest.

## Install and run

Install dependencies and start the development build:

```bash
npm install
npm run dev
```

Build the app and CLI:

```bash
npm run build
```

Create a platform package under `release/`:

```bash
npm run package
```

Expose the CLI commands locally during development:

```bash
npm link
ants doctor --json
```

Both `ants` and `ants-nest` invoke the same CLI.

## One-time Cloudflare setup

Setup can be completed in the Electron app or CLI. The resulting configuration is shared immediately.

Interactive or environment-based setup:

```bash
export CLOUDFLARE_PROXY_DOMAIN="example.com"
export CLOUDFLARE_ZONE_ID="..."
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_API_TOKEN="..."
ants setup --json
```

For automation, pass identifiers as flags and send the token over stdin:

```bash
printf '%s' "$CLOUDFLARE_API_TOKEN" | ants setup \
  --proxy-domain example.com \
  --zone-id "$CLOUDFLARE_ZONE_ID" \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --api-token-stdin \
  --json
```

Avoid `--api-token` in automation because command arguments can appear in shell history and process listings. Successful setup output never includes the token.

## CLI usage

### Create an expiring quick share

Quick shares always require either a duration or exact expiration time:

```bash
ants share 3000 \
  --name "Checkout preview" \
  --description "Current checkout flow for mobile review" \
  --expires 1h \
  --json
```

Accepted durations use `m`, `h`, or `d`, from one minute through 30 days. Exact times accept ISO timestamps or local date/time values:

```bash
ants share http://localhost:5173 \
  --name "Scheduled demo" \
  --description "Frontend build for the product demo" \
  --expires-at "2026-08-16T17:30:00+05:45" \
  --json
```

### Create a named tunnel

Named tunnels remain active until stopped or removed unless an expiration is supplied:

```bash
ants create docs-preview \
  --description "Documentation preview for the product team" \
  --url http://localhost:3000 \
  --json
```

The CLI derives `docs-preview-share.example.com`; agents cannot select or replace arbitrary hostnames.

### Inspect and clean up

```bash
ants list --json
ants logs <profile-id>
ants stop <profile-id> --json
ants remove <profile-id>
```

Use IDs from JSON output when automating. Names are accepted but can become ambiguous. `stop` and `remove` both release managed Cloudflare resources; repeated cleanup may report that the profile no longer exists.

See [.agents/skills/ants-nest-cli/SKILL.md](.agents/skills/ants-nest-cli/SKILL.md) for the agent workflow bundled with this repository.

## Phone access

Select **Enable phone access** in Electron to create `antsnest.<domain>` and a single-use pairing QR code. Each paired browser exchanges that code for its own random device token. The desktop app lists authorized devices and can revoke one browser or all browsers at any time.

Pairing credentials live in the URL fragment and are not sent in HTTP requests. The remote server binds to `127.0.0.1`, rejects unauthenticated API calls, compares token hashes in constant time, limits request bodies, and does not enable cross-origin access. Closing phone access removes the public route and invalidates every device.

## Local state and real-time updates

Ants Nest stores runtime data under `~/.ants-nest` by default:

- `state.sqlite` — tunnel profiles and sessions
- `cloudflare.json` — Cloudflare identifiers and API token
- `tokens/` — individual connector tokens
- `logs/` — connector logs
- `bin/` — verified managed `cloudflared` installation

Override the directory with `ANTS_NEST_HOME` or the executable with `CLOUDFLARED_BIN`. The four `CLOUDFLARE_*` environment variables take precedence over saved setup values.

SQLite transactions coordinate concurrent Electron and CLI writes. A user-only local socket signals committed changes to an open Electron process, so agent-created tunnels appear in the dashboard without polling or JSON state files.

## Security model

- The renderer is sandboxed behind a narrow typed preload bridge.
- Child processes use argument arrays with `shell: false`.
- API and connector tokens use user-only files and are never returned to the renderer.
- Connector tokens are supplied with `--token-file`, not process arguments.
- DNS cleanup verifies record ownership before deletion.
- Existing DNS records are never modified or replaced.
- Public shares expose the configured local service to the Internet; use the shortest practical lifetime.

## Development

Run the complete validation suite:

```bash
npm run check
```

Individual commands:

```bash
npm run typecheck
npm test
npm run build
```

The architecture follows the useful boundaries demonstrated by [T3 Code](https://github.com/pingdotgg/t3code): an Electron host, isolated renderer bridge, reusable core services, typed contracts, a first-class CLI, and local ownership of credentials and data.
