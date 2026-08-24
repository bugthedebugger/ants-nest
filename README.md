# Ants Nest

Ants Nest is a local-first Electron app and CLI for publishing local services through Cloudflare Tunnel. It gives humans a desktop app and a paired Remote access dashboard while giving coding agents a predictable, JSON-friendly command line.

There is no Ants Nest account or hosted backend. The desktop app, CLI, Cloudflare credentials, tunnel state, and authorized-device state all live on your machine.

## Highlights

- Create expiring quick shares and longer-lived named tunnels.
- Share a file or folder directly without starting a separate web server.
- Protect file and folder shares with a random access token by default, with an explicit public-share option.
- Use any available first-level hostname from the Electron app or an authorized Remote access dashboard.
- Give agents collision-safe CLI namespaces: `<name>-quick.<domain>` and `<name>-share.<domain>`.
- Control tunnels from any paired device through the Remote access dashboard at `antsnest.<domain>`.
- Give every paired browser its own token and revoke individual devices or all authorized devices immediately.
- Configure Cloudflare once from either the desktop app or CLI.
- Install just the CLI or the complete AppImage + CLI with one command.
- Share one WAL-enabled SQLite state store between Electron and the CLI, with real-time desktop refresh.
- Install and update the official `cloudflared` binary during setup after SHA-256 verification.
- Self-update the CLI with `ants update` and receive desktop app updates in one click, both verified against GitHub Releases.
- Never replace an existing DNS record.

## How hostnames work

Assuming `CLOUDFLARE_PROXY_DOMAIN=example.com`:

| Surface | Quick share | Named tunnel |
| --- | --- | --- |
| Electron / Remote access dashboard | User enters an unused label such as `review`; Ants Nest appends the configured domain to form `review.example.com` | User enters an unused label such as `docs`; Ants Nest appends the configured domain to form `docs.example.com` |
| CLI / agents | `<slug>-quick.example.com` | `<slug>-share.example.com` |
| Remote access dashboard host | `antsnest.example.com` | — |

These are first-level subdomains, so a normal full Cloudflare zone can serve them with Universal SSL. Ants Nest checks the exact hostname before provisioning and refuses to continue if any DNS record already occupies it. There is no replace or override option.

Stopping, removing, or expiring a managed share terminates its connector, deletes the DNS record and Cloudflare Tunnel owned by Ants Nest, removes its connector token, and releases the hostname. Treat `stop` as terminal for that share; create a new one if it is needed again.

Cloudflare can briefly report active tunnel connections after the local `cloudflared` process exits. Because every managed tunnel is dedicated to one Ants Nest share and `stop` is terminal, Ants Nest clears that tunnel's stale connector records and retries deletion during the propagation window. If Cloudflare still refuses cleanup, local access stays stopped and the retained profile can be passed to `ants stop` again later.

## Install

Install only the CLI on Linux or macOS (requires Node.js 22.13.0 or newer):

```bash
curl -fsSL https://raw.githubusercontent.com/bugthedebugger/ants-nest/main/install.sh | sh -s -- --cli-only
```

Install only the CLI on Windows from PowerShell (requires Node.js 22.13.0 or newer):

```powershell
irm https://raw.githubusercontent.com/bugthedebugger/ants-nest/main/install.ps1 | iex
```

Install the Linux desktop AppImage and CLI together (does not require Node.js):

```bash
curl -fsSL https://raw.githubusercontent.com/bugthedebugger/ants-nest/main/install.sh | sh -s -- --all
```

All installers download assets from the latest GitHub release, verify GitHub's SHA-256 digest, and refuse to replace unrelated commands. Linux and macOS install `ants` plus `ants-nest` under `~/.local/bin`; Windows installs native launchers under `%LOCALAPPDATA%\Ants Nest\bin` and adds that directory to the user PATH. The Linux full install also adds Ants Nest to the desktop application menu. You can inspect [install.sh](install.sh) or [install.ps1](install.ps1) before executing it.

From any packaged desktop build, open **Settings → Agent CLI → Install CLI**. Linux copies the AppImage to a stable user-local location and uses its bundled runtime; macOS and Windows create native launchers for the installed desktop executable.

## Requirements

- Node.js 22.13.0 or newer for development or standalone CLI installation on Linux, macOS, or Windows. This minimum keeps the native SQLite API available without experimental runtime flags. The Linux AppImage-backed CLI includes its own runtime.
- A Cloudflare zone and an API token with:
  - Account → Cloudflare Tunnel → Edit
  - Zone → DNS → Edit

You do not need to install `cloudflared` manually. Setup downloads the current official binary into Ants Nest's private data directory and verifies its published SHA-256 digest.

## Develop from the repository

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

Platform-specific release commands also stage only the public assets under `artifacts/<platform>/`:

```bash
npm run package:linux
npm run package:mac
npm run package:windows
```

## Releases

A push to `main` that increases the version in `package.json` starts the release workflow. Keep the lockfile synchronized by using npm for the bump:

```bash
npm version patch --no-git-tag-version
```

The workflow validates the version change, runs the checks, builds an x64 Linux AppImage, an Apple-silicon DMG and updater ZIP, an x64 Windows NSIS installer and portable executable, and the standalone CLI. It creates a draft GitHub release only after every platform succeeds and verifies that both Windows executables are present; publishing the draft remains a manual step.

The macOS app is ad-hoc signed because the project does not have an Apple Developer ID, and CI verifies that signature before uploading the DMG. Squirrel.Mac cannot automatically replace an ad-hoc-signed app, so the in-app update button opens the matching DMG for manual installation. Apple also does not notarize ad-hoc-signed apps, so Gatekeeper quarantines the app after an internet download. After verifying the DMG against the release's `checksums.txt`, drag Ants Nest to Applications and remove quarantine before opening it:

```bash
xattr -dr com.apple.quarantine "/Applications/Ants Nest.app"
open "/Applications/Ants Nest.app"
```

Only use this workaround for an Ants Nest DMG whose checksum you have verified. A normal click-to-open installation without this step requires a paid Apple Developer Program membership, a Developer ID Application certificate, and Apple notarization.

You can exercise the release logic locally without pushing:

```bash
npm run release:metadata -- --previous-version 0.3.0
npm test
npm run package:linux
env -u ELECTRON_RUN_AS_NODE -u FONTCONFIG_FILE ./artifacts/linux/Ants.Nest.AppImage --cli --version
node artifacts/linux/ants-nest-cli.cjs --version
```

Use the version immediately before the current `package.json` value for `--previous-version`; the JSON result should contain `"shouldRelease": true`. Native DMG and NSIS packaging still require macOS and Windows respectively, so those two final installers are produced by their GitHub-hosted runners.

Install only the repository CLI:

```bash
npm run install:cli
ants doctor --json
```

On Linux, install both the locally built AppImage and its CLI/Desktop entry:

```bash
npm run install:all
```

Remove managed installations with `npm run uninstall:cli` or `npm run uninstall:all`. Both `ants` and `ants-nest` invoke the same CLI.

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

### Share a file or folder directly

Ants Nest includes a small, local-only static server, so neither you nor an agent needs to start a separate web server. Pass an existing file or folder as the positional value, or use `--path` explicitly:

```bash
ants share ./file.html \
  --name "File preview" \
  --description "Standalone HTML file for review" \
  --expires 1h \
  --json

ants share --path ./dist \
  --name "Built site" \
  --description "Production build output for review" \
  --expires 4h \
  --json
```

File and folder shares require a random token by default. Their `publicUrl` includes `?token=...` and is the link to send to the intended recipient. Opening the bare hostname, or using an invalid token, does not expose any file: it shows an Ants Nest token-entry page instead. After successful verification, Ants Nest stores authorization in a secure, HTTP-only cookie and removes the token from the browser address bar. Folder shares serve `index.html` when one exists and otherwise show a simple directory browser.

The Electron app and paired Remote access dashboard expose the same choice between a local service and a file/folder path. Both accept only the first-level subdomain label and append the configured Cloudflare domain. File and folder mode enables token verification by default, with an explicit opt-out for intentionally public content.

To intentionally create a public file or folder share, opt out explicitly:

```bash
ants share --path ./public-report.pdf \
  --name "Public report" \
  --description "Report intended for unrestricted distribution" \
  --expires 1h \
  --no-token \
  --json
```

The same options work for named shares by using `ants create <name> --path <file-or-folder>`. Use exactly one of `--url` and `--path` with `ants create`.

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

### Update the CLI

`ants update` compares the running version against the latest GitHub release, then downloads the new CLI, verifies its SHA-256 digest against the release's `checksums.txt`, smoke-tests it, and atomically swaps it in place with rollback:

```bash
ants update --check   # report whether an update is available
ants update           # install the latest version
ants update --json    # machine-readable result
```

When the launcher is backed by the AppImage, `ants update` replaces that AppImage so the desktop app updates together with it. npm-managed installs print the matching `npm install -g` command instead of touching files. The desktop app also checks GitHub Releases on its own and offers updates through an icon button at the bottom of the sidebar; ad-hoc-signed macOS builds open the DMG for manual installation.

See [.agents/skills/ants-nest-cli/SKILL.md](.agents/skills/ants-nest-cli/SKILL.md) for the agent workflow bundled with this repository.

## Remote access

Open **Remote access** in Electron and select **Enable remote access** to create `antsnest.<domain>` and a single-use pairing QR code. Each paired browser exchanges that code for its own random device token. The desktop app lists authorized devices and can revoke one browser or all browsers at any time.

Once enabled, Remote access runs as a lightweight background service: closing the desktop window does not take the URL offline, and opening Ants Nest again reconnects to the same service. Ants Nest also installs a user-login autostart entry while Remote access is enabled so the dashboard returns after a logout or reboot. Disabling Remote access removes that entry, releases the hostname, and lets the background process exit.

The running desktop app can also create and revoke device access through the CLI:

```bash
ants remote status
ants remote enable
ants remote pair
ants remote revoke <device-id>
ants remote revoke-all
ants remote disable
```

`ants remote pair` prints the complete one-time pairing URL and a terminal QR code. The Ants Nest background service must be active because it owns the local Remote access server; it remains active after the window closes while Remote access is enabled. Use `--json` for machine-readable state; pairing JSON includes both `pairingUrl` and the rendered `qr` string.

Pairing credentials live in the URL fragment and are not sent in HTTP requests. The remote server binds to `127.0.0.1`, rejects unauthenticated API calls, compares token hashes in constant time, limits request bodies, and does not enable cross-origin access. Ending Remote access removes the public route and invalidates every device.

## Local state and real-time updates

Ants Nest stores runtime data under `~/.ants-nest` by default:

- `state.sqlite` — tunnel profiles and sessions
- `cloudflare.json` — Cloudflare identifiers and API token
- `tokens/` — individual connector tokens
- `shares/` — user-only file-share server configurations and access tokens
- `logs/` — connector logs
- `bin/` — verified managed `cloudflared` installation

On Linux, enabled Remote access also creates the managed autostart entry `~/.config/autostart/ants-nest-remote.desktop`.

Override the directory with `ANTS_NEST_HOME` or the executable with `CLOUDFLARED_BIN`. The four `CLOUDFLARE_*` environment variables take precedence over saved setup values.

SQLite transactions coordinate concurrent Electron and CLI writes. User-only local sockets signal committed tunnel changes to Electron and let the CLI safely request Remote access operations from the running app, so both interfaces stay on the same runtime and revocation state.

## Security model

- The renderer is sandboxed behind a narrow typed preload bridge.
- Child processes use argument arrays with `shell: false`.
- API and connector tokens use user-only files and are never returned to the renderer.
- File-share access tokens are generated randomly, stored in user-only files, and only included in the intended share URL. Bare and invalid-token requests cannot read shared content.
- Connector tokens are supplied with `--token-file`, not process arguments.
- DNS cleanup verifies record ownership before deletion.
- Existing DNS records are never modified or replaced.
- Local-service shares and file shares created with `--no-token` are public Internet exposure. Keep token verification enabled for private files and use the shortest practical lifetime.

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

## License

Ants Nest is available under the [MIT License](LICENSE).
