---
name: antigravity-provider
description: "Configure, use, or troubleshoot the first-class Antigravity provider plugin (`antigravity`) in BB: authentication, permission and Plan modes, compaction, quota, CLI install/update, and native skills."
---

# Antigravity provider

The `antigravity` plugin registers Google Antigravity (`agy`) as a first-class BB provider (`providerId: "antigravity"`).

## Quick commands

- List models on a machine:
  ```sh
  bb provider models antigravity --environment "$BB_ENVIRONMENT_ID"
  ```
- Spawn a thread:
  ```sh
  bb thread spawn --provider antigravity --model gemini-4-neon --reasoning high
  ```
- Check quota on a machine:
  ```sh
  bb settings usage --machine <id-or-name> --json
  ```
- Compact a live thread:
  ```sh
  bb thread compact "$BB_THREAD_ID"
  ```

## Authentication

`agy acp` reuses credentials stored by Antigravity CLI on the thread's host:

- **Interactive OAuth (desktop/local):** run `agy` once on that machine.
- **Headless / SSH:** run `agy acp --login` on that machine and paste the browser code.
- **Gemini API key:** set `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` and export `GEMINI_API_KEY` (optional `GOOGLE_GEMINI_BASE_URL`).
- **Vertex AI / Enterprise ADC:** run `gcloud auth application-default login` and set `AGY_ADC_AUTH=true` (or `"userSettings": { "enableAdc": true }` in `~/.gemini/config/config.json`) with `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`.

## Permission modes & Plan mode

BB's native controls map directly to `agy acp` session modes:

- **Accept Edits (`accept-edits`):** runs `agy` in `accept-edits` mode; workspace file edits proceed without prompting and commands/external access ask BB.
- **Auto (`auto`):** runs `agy` in `auto` mode; edits and safe commands proceed without prompting and irreversible actions ask BB.
- **Full (`full`):** runs `agy` in `auto` mode with BB auto-approving remaining requests, avoiding process restarts when toggling modes or entering Plan mode.
- **Plan (`/plan`):** switches the turn to `agy`'s `plan` mode and routes plan approval to BB even on `full` threads; the next ordinary turn restores the thread's permission mode.

## Plugin settings

Configure via `bb plugin config antigravity set <key> <value>` or **Settings → Plugins → Antigravity**:

- `sandboxEnabled` (`boolean`, default `false`): passes `--sandbox` to `agy acp` in `accept-edits` and `auto` modes.
- `disableTelemetry` (`boolean`, default `false`): passes `--disable-telemetry` to `agy acp`.
- `defaultAgent` (`string`, default `""`): passes `--agent <name>` to `agy acp`.
- `executablePath` (`string`, default `""`): overrides the `agy` binary path (also honors host `BB_ANTIGRAVITY_EXECUTABLE`).

## Native skills & quota

- **Skill roots:** `~/.gemini/config/skills`, `~/.agents/skills`, workspace `.agents/skills`, `.agent/skills`, `_agents/skills`, `_agent/skills` (walking ancestors to repo root), plus installed plugins under `~/.gemini/config/plugins` and `.agents/plugins` and paths in `skills.json`.
- **Quota:** collected safely on the host via `agy -p /usage --output-format json --log-file /dev/null` with `AGY_CLI_DISABLE_AUTO_UPDATE=true` and browser-opener guards (requires `agy >= 1.1.12`).
- **Install / Update:** BB installs via `https://antigravity.google/cli/install.sh` and updates via `agy update`.
