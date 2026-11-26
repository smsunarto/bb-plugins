# Antigravity Provider for bb

First-class Google Antigravity (`agy`) provider plugin for bb.

## Features

- **Provider ID:** `antigravity` (always visible in the provider picker, with install/update support when `agy` is missing or outdated).
- **Permission & Plan modes:** Maps bb's `Accept Edits`, `Auto`, `Full`, and `/plan` composer action directly to `agy acp`'s native session modes (`accept-edits`, `auto`, `plan`), hiding the duplicate Agent Options `Mode` selector.
- **Manual compaction:** Supports `/compact` and `bb thread compact`.
- **Immediate reasoning discovery & picker order:** Enriches `model/list` from `agy models` so every model's reasoning efforts (`low`, `medium`, `high`, `xhigh`, or none) are known immediately on cold start, ordered with Gemini 4 flagships first.
- **Native skill & plugin roots:** Discovers `~/.gemini/config/skills`, workspace `.agents/skills` / `.agent/skills` / `_agents/skills` / `_agent/skills` (walking ancestors), and installed Antigravity plugins.
- **Health, quota, and CLI maintenance:** Reports CLI health, non-interactive quota windows via `agy -p /usage --output-format json` (wired into **Settings → Provider Usage** and `bb settings usage`), and install (`https://antigravity.google/cli/install.sh`) / update (`agy update`) actions.
- **Antigravity ACP dialect:** Classifies `invoke_subagent` as BB `delegation` items and emits typed `rateLimited` recovery hints for `RESOURCE_EXHAUSTED` / `429` quota errors.
- **Headless:** Zero frontend bundle overhead; uses the monochrome Antigravity SVG mark with `iconTint`.
