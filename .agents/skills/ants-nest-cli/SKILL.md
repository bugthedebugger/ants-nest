---
name: ants-nest-cli
description: Publish and manage local services with the Ants Nest CLI. Use when an agent needs to expose a localhost port or URL, create a temporary review link, create an intentional named tunnel, inspect active Ants Nest tunnels, retrieve connector logs, or clean up a previously created share.
---

# Ants Nest CLI

Use `ants` for commands and request JSON whenever available. Fall back to `ants-nest` if `ants` is not on `PATH`.

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

## Create a named tunnel

Use a named tunnel only when the user explicitly needs a stable or longer-lived route:

```bash
ants create <name> \
  --description "<what is exposed and why>" \
  --url <port-or-url> \
  --json
```

Add `--expires <duration>` or `--expires-at <ISO timestamp>` when a cutoff is known. The CLI always derives `<name>-share.<configured-domain>`.

## Report the result

Parse JSON and return at least:

- `publicUrl`
- `profileId`
- `expiresAt`, when present
- a brief reminder that the URL is public

Do not expose `tokenFile`, connector tokens, Cloudflare credentials, or pairing credentials in user-facing output.

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

## Safety rules

- Treat every share as public Internet exposure.
- Require a meaningful name and description.
- Confirm the intended local port or URL; do not guess between multiple running services.
- Never pass, print, or persist a Cloudflare API token.
- Never use `--api-token` in automation. If explicitly authorized to configure, prefer environment variables or `--api-token-stdin`.
- Never attempt to replace an occupied hostname. Ants Nest deliberately has no override flag.
- Do not bypass the CLI suffix rules; arbitrary hostnames belong to the human-facing Electron or paired-phone UI.
