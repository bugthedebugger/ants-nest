---
name: ants-nest-cli
description: Publish and manage local services, files, and folders with the Ants Nest CLI. Use when an agent needs to expose a localhost port or URL, share a file or folder without creating a separate server, create a temporary review link, create an intentional named tunnel, manage the Remote access dashboard or its paired devices, inspect active Ants Nest tunnels, retrieve connector logs, clean up a previously created share, or check for and install CLI updates.
---

# Ants Nest CLI

Use `ants` for commands and request JSON whenever available. Fall back to `ants-nest` if `ants` is not on `PATH`.

If neither command exists, do not install software without permission. Tell the user that Ants Nest supports standalone CLI installation on Linux, macOS, and Windows, a complete Linux AppImage + CLI installer, and **Settings → Agent CLI → Install CLI** in the packaged desktop app.

## Check readiness

Run:

```bash
ants doctor --json
```

Require both `installed: true` and `authenticated: true` before creating a share. If setup is incomplete, ask the user to configure Ants Nest unless they explicitly provided the four Cloudflare values. Never search the filesystem for credentials.

## Create a quick share

Use a quick share for previews, review links, callbacks, or other temporary access:

```bash
ants share <port-or-url> \
  --name "<short human-readable name>" \
  --description "<what is exposed and why>" \
  --expires <duration> \
  --json
```

Quick shares require exactly one expiration:

- Use `--expires 15m`, `1h`, `4h`, or another `m`/`h`/`d` duration up to 30 days.
- Use `--expires-at <ISO timestamp>` when the user specifies a cutoff time.
- Prefer the shortest lifetime that covers the task.

The CLI always derives `<name>-quick.<configured-domain>`. Do not invent or request a hostname flag.

## Share a file or folder

Use Ants Nest's built-in server instead of starting a separate HTTP server:

```bash
ants share --path <file-or-folder> \
  --name "<short human-readable name>" \
  --description "<what is shared and why>" \
  --expires <duration> \
  --json
```

An existing path may also be passed positionally, such as `ants share ./file.html ...`, but prefer `--path` in automation because it is unambiguous. Folders serve `index.html` when present and otherwise show a directory browser.

Token verification is enabled by default. The returned `publicUrl` contains the access token and is the link to give the intended recipient. The bare hostname must only show a token-entry page; it must never expose shared content. Treat the complete tokenized URL as a sensitive credential and do not paste it into logs or public channels.

Only add `--no-token` when the user explicitly asks for unrestricted public access. Never disable token verification merely for convenience.

## Create a named tunnel

Use a named tunnel only when the user explicitly needs a stable or longer-lived route:

```bash
ants create <name> \
  --description "<what is exposed and why>" \
  --url <port-or-url> \
  --json
```

For a named file or folder share, replace `--url` with `--path <file-or-folder>`. Token verification remains enabled by default; `--no-token` is the explicit opt-out.

Add `--expires <duration>` or `--expires-at <ISO timestamp>` when a cutoff is known. The CLI always derives `<name>-share.<configured-domain>`.

## Report the result

Parse JSON and return at least:

- `publicUrl`
- `baseUrl`, for token-protected file/folder shares
- `profileId`
- `expiresAt`, when present
- whether the share is token-protected or intentionally public

Do not expose `tokenFile`, `shareConfigFile`, connector tokens, or Cloudflare credentials in user-facing output. A file-share token is intentionally included only in its returned `publicUrl`; treat that complete URL as sensitive. A pairing credential may only be displayed when the user explicitly requests a new Remote access device link; treat it as a sensitive, single-use secret.

## Manage Remote access

Remote commands talk to the Ants Nest background service so the CLI, desktop UI, and paired Remote access dashboard share one live server, SQLite device registry, and revocation state. Once Remote access is enabled, closing the desktop window leaves this service running and a managed login autostart entry restores it after reboot. If the service was explicitly quit, ask the user to open Ants Nest first.

Remote access is independent from ordinary shares and app windows. Never disable it, stop or kill its background service or connector, remove its profile, or terminate its processes as incidental cleanup. This includes broad requests such as “clean up,” “stop the app,” or “stop all processes.” Run `ants remote disable` or otherwise terminate Remote access only when the user explicitly asks to disable, stop, or kill **Remote access itself**. When cleaning up a share, target only that share’s full profile ID and leave Remote access untouched.

```bash
ants remote status --json
ants remote enable --json
ants remote pair
ants remote revoke <full-device-id> --json
ants remote revoke-all --json
ants remote disable --json
```

Use `remote pair` only when the user asks to authorize a new device. It prints the complete single-use Remote access URL and a terminal QR code; generating another pairing invalidates the prior unclaimed pairing code but does not revoke existing devices. Every paired browser receives its own token. Use the full device ID returned by `remote status --json` when revoking one browser.

## Inspect and troubleshoot

```bash
ants list --json
ants logs <profile-id>
```

Use the full profile ID from JSON for mutation commands. Use logs only when creation fails or the user asks for diagnostics; logs may contain origin details.

## Clean up

When the task is finished or the user asks to close access, run one terminal cleanup command:

```bash
ants remove <profile-id>
```

`ants stop <profile-id> --json` is also terminal for managed shares. Both operations stop the connector, delete Ants Nest-owned DNS and Cloudflare Tunnel resources, remove the connector token, and release the hostname. Do not call both; the second call will normally report that the profile no longer exists.

Quick shares also clean themselves up at expiration through a detached watchdog.

Cloudflare may briefly report active connections after the local connector exits. Ants Nest clears stale connector records for its dedicated tunnel and retries cleanup automatically. If retries are exhausted, local access is already offline and the profile remains available; wait briefly, then retry the same `ants stop <profile-id>` command.

## Update the CLI

When the user asks to update the CLI or reports a missing command or flag that a newer version provides, check first:

```bash
ants update --check --json   # { currentVersion, latestVersion, updateAvailable }
```

Then run `ants update` only when the user asked for the update or confirmed it. The command downloads the new CLI, verifies its SHA-256 digest against the release checksums, smoke-tests it, and swaps it in place; the running process keeps its old code until restarted. Do not run `ants update` unprompted during unrelated tasks.

## Safety rules

- Treat local-service shares and file shares created with `--no-token` as public Internet exposure. Treat tokenized file-share URLs as bearer credentials.
- Require a meaningful name and description.
- Confirm the intended local port, URL, file, or folder; do not guess between multiple possible sources.
- Never pass, print, or persist a Cloudflare API token.
- Never use `--api-token` in automation. If explicitly authorized to configure, prefer environment variables or `--api-token-stdin`.
- Never attempt to replace an occupied hostname. Ants Nest deliberately has no override flag.
- Do not bypass the CLI suffix rules. In Electron or an authorized Remote access dashboard, the user chooses only the first-level subdomain label; Ants Nest appends the configured base domain.
- Treat Remote access as persistent user state, not a disposable process. Never stop or disable it unless the user explicitly names Remote access as the target.
