---
name: grokbot
description: Send a message, a bb thread's context, or a ping to the user's Grok Bot webhook with `bb grokbot`, and read the send log. Use when the user asks to tell, ping, or hand a thread to Grok Bot.
---

# Grok Bot

`bb grokbot` POSTs to the one Grok Bot webhook configured on the bb server.
Each command makes one request with an 8-second timeout and does not retry.

- `bb grokbot status` reports whether the config is usable and lists bot ids.
- `bb grokbot ping [--bot <id>]` reports the HTTP status.
- `bb grokbot send "<text>" [--bot <id>] [--thread here|<thread id>]` sends a
  message. `--thread here` attaches this thread's id, project, and branch.
- `bb grokbot log [--limit <n>]` lists recent sends, newest first.

Add `--json` for machine-readable output. A failed send exits 1 and is still
logged.

If `status` reports not configured, tell the user the reason it prints. The
config file is `~/.config/bb-grokbot/config.json` on the server, mode 600,
with `url`, `key`, and optional `bots: [{id, name}]`. Never read, print, or
edit that file, and never ask the user for the key: they manage it themselves.

Only pass `--bot` with an id that `status` lists; otherwise omit it and the
router chooses.
