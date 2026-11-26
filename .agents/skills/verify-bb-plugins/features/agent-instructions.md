# Agent Instructions

Agent Instructions adds an **Agent instructions** page to bb's nav rail with three editors: **Global** edits the file-based source folder (`<dataDir>/plugins/agent-instructions/source/`) holding global instruction docs (`instructions/*.md`), scoped rules (`rules/*.md`), and skills (`skills/<name>/...`), publishes them into bb's user tier (`<dataDir>/AGENTS.md` and `<dataDir>/skills/<name>`), and syncs them two-way with every connected remote host's mirror (`<hostDataDir>/mirror/`). **Projects** edits a registered checkout's `AGENTS.md`, `CLAUDE.md`, `.bb/AGENTS.md`, and project skills. **Plugin prompts** edits the agent-facing Markdown of plugins installed from a local path and reloads them. A `bb agent-instructions …` CLI covers `path`, `catalog`, `list`, `preview`, `publish`, `sync`, `migrate`, and thin file-write helpers.

## Sub-features

- `ai-nav` opens the page from the nav rail and switches editors with the `Global`, `Projects`, and `Plugin prompts` buttons.
- `ai-global-overview` shows the Global overview, the server source path, the `N skills · N docs` status, sync conflict notices, and the publish state.
- `ai-disk-edit` edits `instructions/*.md`, `rules/*.md`, or `skills/<name>/...` directly on disk without any CLI write call; the server watcher reloads, publishes to `<dataDir>/AGENTS.md` and `<dataDir>/skills/<name>`, updates rule delivery for new threads, and refreshes open Global editors live via `sourceChanged`.
- `ai-mirror-sync` syncs `source/` two-way with each connected non-primary host's `<hostDataDir>/mirror/` (watching via `experimental_watch` and `mirrorChanged`), and preserves concurrent edits under `conflicts/<host>-<timestamp>/<path>` without publishing `conflicts/`.
- `ai-migrate` exports legacy SQLite `data.db` and KV `state` rules losslessly to `source/` (`bb agent-instructions migrate`, dry-run by default; `--apply` to write and verify).
- `ai-doc-create` creates a global instructions doc (`instructions/<id>.md`) from `+ New doc`.
- `ai-doc-edit` edits, saves (`Save`, Ctrl/Cmd+S), and reverts a doc. The saved text is published as `<dataDir>/AGENTS.md`.
- `ai-doc-toggle` turns a doc off and on (`enabled: false` in frontmatter). An off doc leaves `AGENTS.md`.
- `ai-doc-rename` renames a doc (updates `name` in frontmatter).
- `ai-doc-delete-restore` moves a doc to server trash (`Recently deleted`), restores it, or drops it with `Remove for good`.
- `ai-skill-create` creates a catalog skill (`skills/<name>/SKILL.md`) from `+ New skill`. The skill is published as a link `<dataDir>/skills/<name>`.
- `ai-skill-edit` edits and saves a skill file, adds a file with `New file`, and deletes a file.
- `ai-skill-toggle` turns a skill off and on (`skills/<name>/.disabled`). An off skill loses its user-tier link.
- `ai-skill-delete-restore` moves a whole skill to server trash, then restores it or removes it for good.
- `ai-skill-validate` refuses a bad skill name, an empty description, a duplicate name, a name that would shadow a skill bb already delivers, and a `SKILL.md` whose frontmatter `name` does not match.
- `ai-filter` filters docs, skills, and skill files from `Filter the catalog`.
- `ai-conflict` shows `This file changed on disk after you started editing.` with `Discard mine` and `Overwrite with mine` when an on-disk edit or CLI write lands under an unsaved draft.
- `ai-publish` publishes from the status line `Publish` button, `Retry publish`, or `bb agent-instructions publish`. It reports a `clash` when a user-tier entry it did not create blocks a name.
- `ai-rules` adds, names, scopes (machine, provider, project, model glob), toggles, and deletes rules (`rules/<id>.md`) on `global/rules`, which autosave. The CLI twins are `list`, `add`, and `remove`.
- `ai-rules-delivery` sends matching rules to a thread's agent through bb's agent configuration, under `The following dynamic instructions come from the BB plugin "agent-instructions":`. Its proof is `bb agent-instructions preview` and the agent's prompt.
- `ai-projects` picks a project and a checkout, lists instruction and skill files, edits, creates, and saves one in the checkout, and detects a conflict.
- `ai-prompts-list` lists each plugin's tools (with `code` and `stale` badges), prompts, skills, and reference files, editable plugins first.
- `ai-prompts-edit` edits a plugin's agent file and `Save & reload`s it. It refuses an edit that adds or removes a `{{placeholder}}`, an empty tool description, a tool thread snippet over 4096 characters, a file that changed on disk, and any edit to a plugin not installed from a path.
- `ai-prompts-code-tool` shows a tool whose description lives in code, read-only.
- `ai-cli-catalog` covers `path`, `catalog`, `sync`, `migrate`, `skill show|create|write|delete`, and `doc show|write|delete`.
- `ai-phone` shows the editor switcher and list in the page and a `Back to …` bar on a compact layout.
- `ai-breadcrumbs` shows the editor › item trail in the title bar, each level linking back up; a compact layout shows only the open item.
- `ai-startup-publish` republishes `source/` each time the plugin loads, finishing a publish an earlier run left half done and logging clashes.

## How to get to it (user POV)

- Choose the **Agent instructions** button in bb's nav rail. The route is `/plugins/agent-instructions/instructions`, which opens Global.
- The page's left sidebar holds the `Instruction editors` nav (`Global`, `Projects`, `Plugin prompts`) above the current editor's list.
- Global routes are `…/instructions/global`, `…/global/docs/<doc-id>`, `…/global/skills/<name>/<path>`, `…/global/rules`, and `…/global/rules/<rule-id>`.
- Projects routes are `…/instructions/projects/<project-id>/<source-id>/<path>`.
- Plugin prompts routes are `…/instructions/prompts/<plugin-id>/file/<path>` and `…/prompts/<plugin-id>/tool/<name>`.
- The CLI is `bb agent-instructions path|sync|migrate|list|add|remove|preview|catalog|publish|skill show|skill create|skill write|skill delete|doc show|doc write|doc delete`.
- There is no plugin settings page, and the plugin registers no agent tool.

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin agent-instructions`, and `--plugin at-plugin` too for the Plugin prompts recipe.
- The test instance's source folder `$INST/data/plugins/agent-instructions/source/` starts empty (`instructions/`, `rules/`, `skills/`):

  ```bash
  SRC=$("$TB" agent-instructions path)
  ls -la "$SRC" "$INST/data/skills" "$INST/data/AGENTS.md" 2>&1 | tee "$EV/ai-usertier-before.txt"
  "$TB" agent-instructions catalog --json | tee "$EV/ai-catalog-before.json"
  "$TB" agent-instructions list --json | tee "$EV/ai-rules-before.json"
  ```

- **Rule delivery and the edited-prompt check need a free agent.** Register the fake agent from SKILL.md **Free agent turns** (provider `acp-verify-fake`) and a fixture thread on it. With `printf '{{ECHO}}\n' > "$FX/reply.md"` its reply quotes every prompt block bb sent, so `thread output` shows what the agent received.
- **Direct on-disk edit (`ai-disk-edit`).**
  - Get the folder with `SRC=$("$TB" agent-instructions path)`.
  - Write `$SRC/instructions/shared.md`, `$SRC/rules/disk-rule.md` (with `when.providers: ["acp-verify-fake"]`), and `$SRC/skills/disk-skill/SKILL.md` directly with plain shell/file writes (no `bb agent-instructions` write call).
  - Wait ~500 ms for the watcher debounce and publish, then verify:
    - `cat "$INST/data/AGENTS.md"` matches `shared.md`.
    - `cat "$INST/data/skills/disk-skill/SKILL.md"` matches `disk-skill/SKILL.md`.
    - `"$TB" agent-instructions preview --thread <tid>` shows `disk-rule.md`'s text, and a new turn on `<tid>` receives the updated global doc, rule, and skill.
    - An open Global tab updates live without a manual reload; an open unsaved draft flags `This file changed on disk after you started editing.` with `Discard mine` and `Overwrite with mine`.
- **Two-host mirror sync (`ai-mirror-sync`).**
  - With a second enrolled host connected to the test server, run `MIRROR=$("$TB" agent-instructions path --host <host2>)`.
  - Confirm a file written in `$SRC` arrives in `$MIRROR`, and a file edited in `$MIRROR` flows back to `$SRC`, updates `<dataDir>/AGENTS.md` / `<dataDir>/skills/`, and reaches a new thread's prompt.
  - Edit the same file concurrently on both `$SRC` and `$MIRROR` (while offline or before sync): verify the server version stays at the canonical path and the host's bytes are preserved under `conflicts/<host>-<timestamp>/<path>`.
- **Open from the nav rail (`ai-nav`).** Run `agent-browser --session "$RUN" open "$URL"`, `wait --text "New thread"`, and click `Agent instructions`. Confirm the overview shows the source path and `Published`.
- **Create, edit, toggle, rename, delete, restore docs and skills (`ai-doc-*`, `ai-skill-*`).** Drive `+ New doc`, `+ New skill`, `Save` (`Control+s`), `Revert`, `Rename`, `Switch`, `Delete doc` / `Delete skill`, and `Recently deleted` (`Restore` / `Remove for good`). Confirm every UI action writes/removes the corresponding file under `$SRC` and updates `$INST/data/AGENTS.md` or `$INST/data/skills/<name>`.
- **Conflict detection (`ai-conflict`).** Open a file in the Global tab, switch to `Markdown source`, type a draft without saving, then modify the file directly on disk under `$SRC`. Confirm the banner `This file changed on disk after you started editing.` appears with `Discard mine` and `Overwrite with mine`, keeping the draft intact until chosen.
- **Rules (`ai-rules`, `ai-rules-delivery`).** Drive `+ New rule` on `global/rules`, verify `$SRC/rules/<id>.md` is written on disk with YAML frontmatter and body, and verify delivery via `"$TB" agent-instructions preview --thread <tid>` and fake-agent `thread output`.
- **Projects (`ai-projects`) and Plugin prompts (`ai-prompts-*`).** Unchanged from previous recipes: verify project checkout editing and local-path plugin prompt `Save & reload` + placeholder guard.
- **Phone layout (`ai-phone`).** Set viewport `390 844 3`, verify switcher + list home and `Back to Global` bar.

## Gotchas

- Publishing writes into the test instance's data dir, `$INST/data`, never live's. Never run these recipes against bare `bb`.
- `source/` edits trigger live UI invalidation via `sourceChanged`; an unmodified open editor refreshes automatically, while an unsaved draft surfaces the conflict banner instead of discarding typed text.
- `conflicts/` files are synced across hosts for easy diff/merge and are intentionally excluded from `AGENTS.md`, rules, and published skills.
- `preview` only knows sessions seen since the plugin last loaded. A `plugin reload` or bb restart clears them.
- Markdown fields default to rich text; choose `Markdown source` before `fill`.
