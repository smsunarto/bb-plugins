# Agent Instructions

**Global** manages global instruction docs, scoped rules, and shared skills stored as plain files in a bb-synced source folder. **Projects** edits a registered checkout's `AGENTS.md`, `CLAUDE.md`, `.bb/AGENTS.md`, and project skills. **Plugin prompts** inspects and edits agent-facing Markdown shipped by local-path plugins.

## File-based global source and multi-machine sync

Global instructions, rules, and catalog skills live as plain editable files owned by the bb server:

```text
<serverDataDir>/plugins/agent-instructions/source/
  instructions/<id>.md     # Global docs published as <dataDir>/AGENTS.md
  rules/<id>.md            # Scoped rules (YAML frontmatter + Markdown body)
  skills/<name>/...        # Skills (SKILL.md + references/scripts), published to <dataDir>/skills/<name>
  conflicts/<host>-<ts>/…  # Conflict copies from concurrent edits (never published)
```

- **Edit directly with ordinary file tools:** run `bb agent-instructions path` to get the editable folder on your current machine (the server folder on the primary host, or `<daemonDataDir>/plugins/agent-instructions/host-data/mirror/` on remote hosts).
- **Automatic publishing and live UI updates:** the server watches `source/`, updates `<dataDir>/AGENTS.md` and `<dataDir>/skills/<name>`, updates rule delivery for new threads, and refreshes open **Global** tabs in realtime.
- **Two-way host mirror sync:** every connected non-primary host keeps an editable mirror at `<daemonDataDir>/plugins/agent-instructions/host-data/mirror/` watched via the daemon's native watcher. Edits made in a mirror sync back to the server, publish for new threads, and fan out to other hosts.
- **Conflict safety:** concurrent edits on two machines are never silently lost. The server keeps its version at the canonical path and writes the host's bytes to `conflicts/<host>-<timestamp>/<path>` on the server and all mirrors. `conflicts/` is never published to agents and is surfaced in the Global tab and CLI.
- **One-time migration:** `bb agent-instructions migrate` (dry-run by default; `--apply` to write) exports legacy SQLite (`data.db`) docs/skills and KV (`state`) rules losslessly into `source/` and verifies every file.

### File formats

- **Global docs (`instructions/<id>.md`):** plain Markdown works with no frontmatter (`name` defaults to the filename stem, `enabled` defaults to `true`). Optional YAML frontmatter supports `name`, `enabled`, and `order`.
- **Scoped rules (`rules/<id>.md`):** optional YAML frontmatter (`name`, `enabled`, `order`, `when: { hosts, providers, models, projects }`) followed by the rule body. Combined rule text per thread is capped at 32,768 characters (`bb.agents.configure` limit).
- **Skills (`skills/<name>/...`):** `SKILL.md` with valid `name` (matching the folder) and `description` frontmatter, plus any supporting files (executable bit preserved). Adding an empty `skills/<name>/.disabled` disables a skill without deleting its files.

## CLI

- `bb agent-instructions path [--host <id>] [--json]` — print the editable folder path on this machine.
- `bb agent-instructions catalog [--json]` — list global docs, skills, and sync conflicts.
- `bb agent-instructions list [--json]` — list scoped rules in delivery order.
- `bb agent-instructions preview [--thread <id>]` — print the rules matching a thread's session.
- `bb agent-instructions publish [--json]` — force republishing `source/` to bb's user tier.
- `bb agent-instructions sync [--host <id>] [--json]` — reconcile `source/` with connected host mirrors (or one specific host).
- `bb agent-instructions migrate [--apply] [--json]` — dry-run or run lossless migration from legacy SQLite/KV.
- Thin file-write helpers remain available: `add`, `remove`, `skill show|create|write|delete`, and `doc show|write|delete`.

## Plugin prompts

Open **Agent instructions → Plugin prompts** in the bb nav rail. Each installed plugin lists:

- **Tools**: every agent tool bb reports for the plugin. A tool backed by `instructions/tools/<tool>.md` is editable. A tool tagged **code** keeps its description in code and is shown read-only. A tool tagged **stale** has a file that differs from what agents currently see.
- **Prompts**: `instructions/*.md` files the plugin reads at runtime.
- **Skills**: `skills/**/*.md`.

**Save & reload** (⌘S) writes the file into the plugin's source directory and reloads the plugin, so new tool descriptions reach agents at once.

### Limits

- Only plugins installed from a local path are editable in **Plugin prompts**.
- A save fails if the file changed on disk since you opened it.
- `{{placeholders}}` are filled by the plugin's code. A save that adds or removes one is rejected.
- A tool thread snippet is capped at 4096 characters, the host limit.

### Making a plugin editable

Keep agent text in Markdown and read it with `@bb-plugins/instructions`:

```ts
import { instructionFiles } from "@bb-plugins/instructions";

const files = instructionFiles(import.meta.url);

bb.agents.registerTool({ name: "notes_find", ...files.tool("notes_find"), parameters, execute });
files.read("review-title", { count });
```

Include `instructions/` in the package's `files` list.
