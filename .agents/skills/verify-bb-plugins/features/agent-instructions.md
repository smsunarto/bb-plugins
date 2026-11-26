# Agent Instructions

Agent Instructions adds an **Agent instructions** page to bb's nav rail with three editors: **Global** edits the file-based source folder (`<dataDir>/plugins/agent-instructions/source/`) holding global instruction docs (`instructions/*.md`), scoped rules (`rules/*.md`), and skills (`skills/<name>/...`), publishes them into bb's user tier (`<dataDir>/AGENTS.md` and `<dataDir>/skills/<name>`), and syncs them two-way with every connected remote host's mirror (`<daemonDataDir>/plugins/agent-instructions/host-data/mirror/`). **Projects** edits a registered checkout's `AGENTS.md`, `CLAUDE.md`, `.bb/AGENTS.md`, and project skills. **Plugin prompts** edits the agent-facing Markdown of plugins installed from a local path and reloads them. A `bb agent-instructions …` CLI covers `path`, `catalog`, `list`, `preview`, `publish`, `sync`, `migrate`, and sha-guarded skill and doc edits.

## Sub-features

- `ai-nav` opens the page from the nav rail and switches editors with the `Global`, `Projects`, and `Plugin prompts` buttons.
- `ai-global-overview` shows the Global overview, the server source path, the `N skills · N docs` status, sync conflict notices, and the publish state.
- `ai-disk-edit` edits `instructions/*.md`, `rules/*.md`, or `skills/<name>/...` directly on disk without any CLI write call; the server watcher reloads, publishes to `<dataDir>/AGENTS.md` and `<dataDir>/skills/<name>`, updates rule delivery for new threads, and refreshes open Global editors live via `sourceChanged`.
- `ai-mirror-sync` syncs `source/` two-way with each connected non-primary host's `<daemonDataDir>/plugins/agent-instructions/host-data/mirror/` (watching via `experimental_watch` and `mirrorChanged`), and preserves concurrent edits under `conflicts/<host>-<timestamp>-<rand>/<path>` without publishing `conflicts/`.
- `ai-migrate` exports legacy SQLite `data.db` and KV `state` rules losslessly to `source/` (`bb agent-instructions migrate`, dry-run by default; `--apply` to stage, verify, atomically swap, and write `migration.json`).
- `ai-doc-create` creates a global instructions doc (`instructions/<id>.md`) from `+ New doc`.
- `ai-doc-edit` edits, saves (`Save`, Ctrl/Cmd+S), and reverts a doc. The saved text is published as `<dataDir>/AGENTS.md`.
- `ai-doc-toggle` turns a doc off and on (`enabled: false` in frontmatter). An off doc leaves `AGENTS.md`.
- `ai-doc-rename` renames a doc (`name` in frontmatter).
- `ai-doc-delete-restore` moves a doc to server trash (`Recently deleted`), restores it, or drops it with `Remove for good`.
- `ai-skill-create` creates a catalog skill (`skills/<name>/SKILL.md`) from `+ New skill`, with a starter `SKILL.md`. The skill is published as a link `<dataDir>/skills/<name>`.
- `ai-skill-edit` edits and saves a skill file, adds a file with `New file`, and deletes a file.
- `ai-skill-toggle` turns a skill off and on (`skills/<name>/.disabled`). An off skill loses its user-tier link.
- `ai-skill-delete-restore` moves a whole skill to server trash, then restores it or removes it for good.
- `ai-skill-validate` refuses a bad skill name, an empty description, a duplicate name, a name that would shadow a skill bb already delivers, and a `SKILL.md` whose frontmatter `name` does not match.
- `ai-filter` filters docs, skills, and skill files from `Filter the catalog`.
- `ai-conflict` shows `This file changed on disk after you started editing.` (or `This file was deleted on disk after you started editing.`) with `Discard mine` and `Overwrite with mine` when an on-disk edit or CLI write lands under an unsaved draft.
- `ai-publish` publishes from the status line `Publish` button, `Retry publish`, or `bb agent-instructions publish`. It reports a `clash` when a user-tier entry it did not create blocks a name.
- `ai-rules` adds, names, scopes (machine, provider, project, model glob), toggles, and deletes rules (`rules/<id>.md`) on `global/rules`, which autosave. The CLI twins are `list`, `add`, and `remove`.
- `ai-rules-delivery` sends matching rules to a thread's agent through bb's agent configuration, under `The following dynamic instructions come from the BB plugin "agent-instructions":`. Its proof is `bb agent-instructions preview` and the agent's prompt.
- `ai-projects` picks a project and a checkout, lists instruction and skill files, edits, creates, and saves one in the checkout, and detects a conflict.
- `ai-prompts-list` lists each plugin's tools (with `code` and `stale` badges), prompts, skills, and reference files, editable plugins first.
- `ai-prompts-edit` edits a plugin's agent file and `Save & reload`s it. It refuses an edit that adds or removes a `{{placeholder}}`, an empty tool description, a tool thread snippet over 4096 characters, a file that changed on disk, and any edit to a plugin not installed from a path.
- `ai-prompts-code-tool` shows a tool whose description lives in code, read-only.
- `ai-cli-catalog` covers `path`, `catalog`, `sync`, `migrate`, `skill show|create|write|delete`, and `doc show|write|delete`, with `--expect <sha256>` guards.
- `ai-phone` shows the editor switcher and list (with source folder and expandable sync conflicts) in the page and a `Back to …` bar on a compact layout.
- `ai-breadcrumbs` shows the editor › item trail in the title bar, each level linking back up; a compact layout shows only the open item. <!-- unverified: added from a source audit, not driven -->
- `ai-startup-publish` republishes `source/` each time the plugin loads, finishing a publish an earlier run left half done and logging clashes. Drive it with `"$TB" plugin reload agent-instructions` and the plugin's logs.

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
- The test instance's source folder `$INST/data/plugins/agent-instructions/source/` starts empty (`instructions/`, `rules/`, `skills/`), `catalog --json` has empty `docs`/`skills`/`conflicts`, `list --json` prints `{"rules":[]}`, `$INST/data/AGENTS.md` does not exist, and `$INST/data/skills` is empty. Record that state before any write:

  ```bash
  SRC=$("$TB" agent-instructions path)
  ls -la "$SRC" "$INST/data/skills" "$INST/data/AGENTS.md" 2>&1 | tee "$EV/ai-usertier-before.txt"
  "$TB" agent-instructions catalog --json | tee "$EV/ai-catalog-before.json"
  "$TB" agent-instructions list --json | tee "$EV/ai-rules-before.json"
  ```

  If `$INST/data/AGENTS.md` already exists and is not a link into `$INST/data/plugins/agent-instructions/`, the plugin leaves it alone and reports a `clash`; `ai-doc-edit` cannot then prove publishing.

- The shadow check and the Projects editor need a project. Create one fixture project with a disposable checkout, and record its id and source id:

  ```bash
  FX="$BB_THREAD_STORAGE/verify/$RUN-fixtures"; mkdir -p "$FX/verify-ai"
  git init -q "$FX/verify-ai" && printf '# verify AGENTS\n' > "$FX/verify-ai/AGENTS.md"
  git -C "$FX/verify-ai" add -A && git -C "$FX/verify-ai" -c user.name=V -c user.email=v@example.invalid commit -q -m init
  "$TB" project create --name verify-ai --root "$FX/verify-ai" --json | jq -r .id
  "$TB" project show <project-id> --json | jq -r '.sources[0].id'   # src_…; .sources[0].hostId is the host
  ```

- **Rule delivery and the edited-prompt check need a free agent.** Register the fake agent from SKILL.md **Free agent turns** (provider `acp-verify-fake`) and a fixture thread on it as [Source Control](source-control.md) **Free local agent** and **Fixture project and thread** describe. With `printf '{{ECHO}}\n' > "$FX/reply.md"` its reply quotes every prompt block bb sent, so `thread output` shows what the agent received.
- **Direct on-disk edit (`ai-disk-edit`).**
  - Get the folder with `SRC=$("$TB" agent-instructions path)`.
  - Write `$SRC/instructions/shared.md`, `$SRC/rules/disk-rule.md` (with `when.providers: ["acp-verify-fake"]`), and `$SRC/skills/disk-skill/SKILL.md` directly with plain shell/file writes (no `bb agent-instructions` write call).
  - Wait ~500 ms for the watcher debounce and publish, then verify:
    - `cat "$INST/data/AGENTS.md"` matches `shared.md`.
    - `cat "$INST/data/skills/disk-skill/SKILL.md"` matches `disk-skill/SKILL.md`.
    - `"$TB" agent-instructions preview --thread <tid>` shows `disk-rule.md`'s text, and a new turn on `<tid>` receives the updated global doc, rule, and skill.
    - An open Global tab updates live without a manual reload; an open unsaved draft flags `This file changed on disk after you started editing.` with `Discard mine` and `Overwrite with mine`.
  - Clean up these fixture files from `$SRC` before proceeding to the UI recipes if you want a clean starting state.
- **Two-host mirror sync (`ai-mirror-sync`).**
  - With a second enrolled host connected to the test server, run `MIRROR=$("$TB" agent-instructions path --host <host2>)`.
  - Confirm a file written in `$SRC` arrives in `$MIRROR`, and a file edited in `$MIRROR` flows back to `$SRC`, updates `<dataDir>/AGENTS.md` / `<dataDir>/skills/`, and reaches a new thread's prompt.
  - Edit the same file concurrently on both `$SRC` and `$MIRROR` (while offline or before `"$TB" agent-instructions sync --host <host2>`): verify the server version stays at the canonical path and the host's bytes are preserved under `conflicts/<host>-<timestamp>-<rand>/<path>`.
- **One-time migration (`ai-migrate`).**
  - On a test instance with legacy `data.db` and KV `state`, run `"$TB" agent-instructions migrate` (dry-run; writes nothing) and confirm `Verification: PASS — 0 mismatches (100% lossless)` and `AGENTS.md sha256: ... (MATCH)`.
  - Run `"$TB" agent-instructions migrate --apply` (or `--apply --force` when replacing an existing non-empty `source/`), confirm `migration.json` is written, and confirm `source/` + `<dataDir>/AGENTS.md` + `<dataDir>/skills/` match.
- **Open from the nav rail (`ai-nav`).** Run `agent-browser --session "$RUN" open "$URL"`, `agent-browser --session "$RUN" wait --text "New thread"`, and `agent-browser --session "$RUN" find role button click --name "Agent instructions"`. Then run `agent-browser --session "$RUN" wait --url "**/plugins/agent-instructions/instructions**"` and `agent-browser --session "$RUN" wait --text "Instructions and skills for every agent" --timeout 15000`.
  - The sidebar has nav `Instruction editors` with buttons `Global` (`aria-pressed="true"`), `Projects`, `Plugin prompts`; the status line `0 skills · 0 docs  Published`; searchbox `Filter the catalog` (placeholder `Filter docs, skills, and files`); and nav `Catalog` with regions `Global instructions` (`No global instructions yet.`, `+ New doc`), `Rules` (`+ New rule`), and `Skills` (`+ New skill`).
  - The overview shows the server source path (`$SRC`).
  - Capture it with `agent-browser --session "$RUN" snapshot -i -c > "$EV/ai-global.snapshot.txt"`.
- **Switch editors.** `find role button click --name "Plugin prompts"` goes to `…/instructions/prompts` and shows nav `Plugins`. `find role button click --name "Projects"` goes to `…/instructions/projects` with combobox `Project` reading `Choose a project` and a `Refresh sources` button. `find role button click --name "Global" --exact` returns to `…/instructions/global`.
- **Create a doc (`ai-doc-create`).**
  - Run `agent-browser --session "$RUN" find role button click --name "+ New doc"`. Textbox `Doc name`, `Cancel`, and `Create` appear in the `Global instructions` region.
  - Run `agent-browser --session "$RUN" find role textbox fill "verify-doc" --name "Doc name"`, then `agent-browser --session "$RUN" find role button click --name "Create" --exact`.
  - The URL becomes `…/global/docs/doc_<hex>`, the region lists button `verify-doc`, and the editor shows heading `verify-doc`, `Rename`, switch `verify-doc on`, disabled `Revert` and `Save`, `Delete doc`, radiogroup `Markdown editing mode` (`Rich text`, `Markdown source`), and textbox `verify-doc`.
  - Record the id with `"$TB" agent-instructions catalog --json | jq -r '.docs[] | select(.name=="verify-doc") | .id'`.
- **Edit and publish a doc (`ai-doc-edit`).**
  - Run `agent-browser --session "$RUN" find role radio click --name "Markdown source"`, then `agent-browser --session "$RUN" find role textbox fill "VERIFY-AI global line" --name "verify-doc"`. The row's name becomes `verify-doc Unsaved`, and `Save` is enabled.
  - Run `agent-browser --session "$RUN" press Control+s`, or `find role button click --name "Save" --exact`.
  - Run `agent-browser --session "$RUN" wait --text "Agents get it in their next session" --timeout 10000`. The notice reads `Saved. Agents get it in their next session.`
  - Prove the side effect:

    ```bash
    cat "$SRC/instructions/<doc-id>.md"
    readlink "$INST/data/AGENTS.md"     # plugins/agent-instructions/agents-md/<sha>.md
    cat "$INST/data/AGENTS.md"          # VERIFY-AI global line
    "$TB" agent-instructions doc show <doc-id>   # the text, then "<doc-id> (verify-doc): sha256 …"
    ```

  - Reload with `agent-browser --session "$RUN" open "$URL/plugins/agent-instructions/instructions/global/docs/<doc-id>"`. The text stays.
- **CLI doc edit (`ai-cli-catalog`).**

  ```bash
  DSHA=$("$TB" agent-instructions doc show <doc-id> --json | jq -r .sha256)   # keys: content, enabled, executable, id, name, sha256, size
  "$TB" agent-instructions doc write <doc-id> --content "VERIFY-AI global line from CLI" --expect "$DSHA"
  # "<doc-id>: saved as revision N, sha256 …" then "Published for new threads"
  cat "$INST/data/AGENTS.md"          # VERIFY-AI global line from CLI
  ```

  An open unmodified editor refreshes live via `sourceChanged`.

- **Toggle a doc off (`ai-doc-toggle`).** Run `agent-browser --session "$RUN" find role switch click --name "verify-doc on"`. The switch's name stays `verify-doc on`; its state is `checked=false`.
  - The label reads `Off`, the row's name becomes `verify-doc off`, the editor says `Off: agents do not get this text.`, and the status reads `Turned off. Agents get it in their next session.`
  - When it is the only doc, `test -e "$INST/data/AGENTS.md" || echo gone` prints `gone`.
  - Run the same click again; `readlink "$INST/data/AGENTS.md"` returns.
- **Rename (`ai-doc-rename`).** Run `agent-browser --session "$RUN" find role button click --name "Rename"`. Textbox `Doc name` (prefilled), `Cancel`, and `Rename` appear. Run `agent-browser --session "$RUN" find role textbox fill "verify-doc-2" --name "Doc name"` and `press Enter`. The row and heading read `verify-doc-2`, and `"$TB" agent-instructions catalog --json | jq '.docs[].name'` lists it.
- **Delete, restore, forget (`ai-doc-delete-restore`).**
  - Run `agent-browser --session "$RUN" find role button click --name "Delete doc"`. An alertdialog with heading `Delete doc?`, `Cancel`, and `Delete doc` opens. Choose the dialog's `Delete doc` by its ref from `snapshot -i -c`.
  - The page returns to `…/instructions/global` with `Deleted verify-doc-2. Restore it from Recently deleted.`, and region `Recently deleted` lists it with a `doc` badge, `Restore`, and `Remove`.
  - Choose `Restore`; the doc is back under `Global instructions` and `AGENTS.md` is linked again.
  - CLI twin: `"$TB" agent-instructions doc delete <doc-id> --expect <sha256>` prints `<doc-id>: saved as revision N` and `Published for new threads`.
  - Choose `Remove` (`--exact`). It turns into `Remove for good` and `Keep`. Choose `Remove for good`; the entry and the `Recently deleted` region leave.
- **Create a skill (`ai-skill-create`).**
  - Run `agent-browser --session "$RUN" find role button click --name "+ New skill"`. Textboxes `Skill name` and `Skill description`, `Cancel`, and `Create` appear.
  - Run `agent-browser --session "$RUN" find role textbox fill "verify-skill" --name "Skill name"`, `agent-browser --session "$RUN" find role textbox fill "Verification fixture skill" --name "Skill description"`, then `agent-browser --session "$RUN" find role button click --name "Create" --exact`.
  - The URL becomes `…/global/skills/verify-skill/SKILL.md`, the kicker reads `Skill · verify-skill`, and the editor shows heading `SKILL.md`, switch `verify-skill on`, `Revert`, `Save`, `New file`, `Delete skill`, textbox `Frontmatter` (`name: verify-skill` / `description: …`), and textbox `SKILL.md` with heading `verify-skill`.
  - Prove the side effect:

    ```bash
    cat "$SRC/skills/verify-skill/SKILL.md"
    ls -l "$INST/data/skills/verify-skill"            # -> ../plugins/agent-instructions/skill-trees/verify-skill/<treeSha>
    cat "$INST/data/skills/verify-skill/SKILL.md"     # name: verify-skill / description: Verification fixture skill
    "$TB" agent-instructions skill show verify-skill  # stderr: SKILL.md sha256, tree sha256, files
    "$TB" skill list --json | jq -c '.. | objects | select((.name? // "") | tostring | test("verify-skill")) | .name'
    ```

- **Skill validation (`ai-skill-validate`).** For each case, open the form with `+ New skill` (it stays open after a refusal), fill both fields, choose `Create` (`--exact`), and read the message under the form:
  - `Bad_Name` gives `"Bad_Name" is not a valid skill name: lowercase letters, digits and single hyphens, up to 64`.
  - `verify-skill` again gives `A skill named verify-skill already exists`.
  - An empty description gives `The description must be 1-1024 characters`. `fill ""` leaves the previous text in place; clear the field with a click, `press Control+a`, and `press Backspace`.
  - `bb-cli`, with a project registered, gives `bb-cli would hide the bb-cli skill from plugin bb-guide; pick another name`.
  - Close the form with `agent-browser --session "$RUN" find role button click --name "Cancel" --exact`.
- **Edit a skill file (`ai-skill-edit`).**
  - On `SKILL.md`, choose radio `Markdown source` and fill textbox `SKILL.md` with `"# verify-skill` + newline + `Edited in the browser."` (a literal newline inside the quoted argument works), then `press Control+s`.
  - `"$TB" agent-instructions skill show verify-skill` prints the frontmatter and the new body, and `readlink "$INST/data/skills/verify-skill"` names a new tree sha.
  - Choose `New file`. Textbox `New file path` holds `references/`, with `Cancel` and a disabled `Open`. Fill it with `references/notes.md` and choose `Open` (`--exact`).
  - The URL becomes `…/skills/verify-skill/references/notes.md`, the sidebar row reads `references/notes.md new`, and the notice reads `New file. Save to add it to verify-skill.` Choose `Markdown source`, fill textbox `references/notes.md` with `notes`, and save with `Control+s`. `cat "$INST/data/skills/verify-skill/references/notes.md"` prints `notes`.
  - Choose `Delete file`. An alertdialog `Delete file?` offers `Cancel` and `Delete file`; choose the dialog's by ref. `test -e "$INST/data/skills/verify-skill/references/notes.md" || echo gone` prints `gone`, and the page returns to `SKILL.md`.
- **Skill off and on (`ai-skill-toggle`).** Run `agent-browser --session "$RUN" find role switch click --name "verify-skill on"`.
  - The editor says `Off: agents do not get this skill.`, `test -e "$SRC/skills/verify-skill/.disabled"` succeeds, and `test -e "$INST/data/skills/verify-skill" || echo unlinked` prints `unlinked`.
  - Run the click again; `.disabled` is removed and the link returns.
- **Filter (`ai-filter`).** Run `agent-browser --session "$RUN" find role searchbox fill "notes" --name "Filter the catalog"`.
  - A skill with a file `references/notes.md` stays listed with that file shown; a query matching a description (`Verification`) keeps its skill.
  - Fill it with `zzz-none`; the `Skills` region shows `Nothing matches “zzz-none”.` Clear it with `fill ""`, which empties a searchbox.
- **CLI skill edit and conflict (`ai-cli-catalog`, `ai-conflict`).**

  ```bash
  "$TB" agent-instructions skill show verify-skill --json | jq -c 'del(.content)'   # skill, path, sha256, size, executable, treeSha, files
  SHA=$("$TB" agent-instructions skill show verify-skill --json | jq -r .sha256)
  "$TB" agent-instructions skill show verify-skill > "$EV/skill.md" 2>/dev/null; echo "CLI edit" >> "$EV/skill.md"
  "$TB" agent-instructions skill write verify-skill SKILL.md --content "$(cat "$EV/skill.md")" --expect "$SHA"
  # "verify-skill/SKILL.md: saved as revision N, sha256 …, tree sha256 …" then "Published for new threads"
  echo "second CLI edit" >> "$EV/skill.md"
  "$TB" agent-instructions skill write verify-skill SKILL.md --content "$(cat "$EV/skill.md")" --expect "$SHA"; echo "exit $?"
  # "SKILL.md changed since you opened it (Run `show` again, merge your change, and pass its sha256 to --expect)", exit 1
  ```

  - A new file takes `--expect new`; a tree sha is refused (`… was deleted (Run `show` again …)`). `SKILL.md` content without YAML frontmatter is refused with `SKILL.md: SKILL.md has no YAML frontmatter`.
  - UI conflict: open `SKILL.md`, choose `Markdown source`, and fill textbox `SKILL.md` with `draft` without saving. From the shell, edit `$SRC/skills/verify-skill/SKILL.md` (frontmatter included) directly on disk or via `skill write`. Live `sourceChanged` refreshes the file metadata and surfaces `This file changed on disk after you started editing.` with `Discard mine` and `Overwrite with mine` even before clicking Save, keeping `draft` intact. Choose `Discard mine`; the textbox shows the disk text.
  - `--file` needs `--host <host-id>` outside a thread (and refuses overriding `--host` inside a thread). Prefer `--content` here.

- **Delete a skill (`ai-skill-delete-restore`).**
  - On `SKILL.md`, choose `Delete skill`. An alertdialog `Delete verify-skill?` offers `Cancel` and `Delete verify-skill`; choose the latter.
  - The notice reads `Deleted verify-skill. Restore it from Recently deleted.`, and `ls "$INST/data/skills/verify-skill"` fails.
  - Choose `Restore`; the link returns.
  - CLI twin: `"$TB" agent-instructions skill delete verify-skill --expect "$("$TB" agent-instructions skill show verify-skill --json | jq -r .treeSha)"` prints `verify-skill: saved as revision N`.
- **Publish (`ai-publish`).** Run `"$TB" agent-instructions publish`.
  - It prints `Published skills: N added, N updated, N removed, N unchanged` and `Global instructions: published|updated|unchanged|not published: no enabled global instructions`, and exits 0.
  - The status line reads `Published` with no button.
- **Rules (`ai-rules`).**
  - Run `agent-browser --session "$RUN" find role button click --name "+ New rule"`. The URL becomes `…/global/rules/rule_<id>`, breadcrumb `Global / Rules`, and a card shows switch `Untitled rule enabled`, textbox `Rule name`, button `Scope: Always` (expanded), `Delete Untitled rule`, toolbars `Machine`, `Provider`, `Project` (each led by `Any machine` / `Any provider` / `Any project`), textbox `Model`, and textbox `Untitled rule instructions`.
  - Run `agent-browser --session "$RUN" find role textbox fill "verify-rule" --name "Rule name"`; the other names follow (`verify-rule instructions`, `verify-rule enabled`). Choose `Markdown source`, then `find role textbox fill "VERIFY rule text" --name "verify-rule instructions"`.
  - Scope: choose a provider button in toolbar `Provider` by its ref (for the delivery check, `verify fake (local, no model)`), and `find role textbox fill "acp-*" --name "Model"`. The scope button's name becomes `Scope: <provider name> · acp-*`.
  - Run `agent-browser --session "$RUN" wait --text "Saved" --timeout 5000`.
  - Confirm `$SRC/rules/<id>.md` exists on disk with YAML frontmatter and body.
  - `"$TB" agent-instructions list --json | jq -c '.rules[] | select(.name=="verify-rule")'` prints `{"id":"rule_…","name":"verify-rule","enabled":true,"instructions":"VERIFY rule text","when":{"hosts":[],"providers":["acp-verify-fake"],"models":["acp-*"],"projects":[]}}`. Reload the page; the card keeps its values.
  - `find role switch click --name "verify-rule enabled"` turns it off; the sidebar row reads `verify-rule off <scope>`, and `list --json` shows `enabled: false`.
  - `find role button click --name "Delete verify-rule"` deletes it at once, with no confirmation; `list --json` prints `{"rules":[]}`.
  - CLI twin: `"$TB" agent-instructions add --name verify-cli --model 'gpt-5*' VERIFY cli rule` prints `Added rule_…, when model gpt-5*`. `"$TB" agent-instructions list` prints `rule_…  verify-cli` and `  when model gpt-5*`. `"$TB" agent-instructions remove <rule-id>` prints `Removed <rule-id>`. `"$TB" agent-instructions add --host here x` outside a thread fails with `"here" only works inside a bb thread`.
- **Rule delivery (`ai-rules-delivery`).** `"$TB" agent-instructions preview --thread <unseen-id>` fails with `No agent session seen for <id> since this plugin loaded (Send the thread a message, then retry.)`. With the rule scoped to the free agent, send the free-agent thread a message (`"$TB" thread tell <tid> "rule check"` and `thread wait`). Then `"$TB" agent-instructions preview --thread <tid>` prints `host <host> · provider verify fake (local, no model) · model acp-default · project <name>` and `VERIFY rule text`, and `"$TB" thread output <tid>` shows the agent received `The following dynamic instructions come from the BB plugin "agent-instructions":` followed by `VERIFY rule text`.
- **Projects (`ai-projects`).**
  - Run `agent-browser --session "$RUN" open "$URL/plugins/agent-instructions/instructions/projects/<project-id>"` and `agent-browser --session "$RUN" wait --text "Checkout / machine"`. Combobox `Project` reads the project's name, and combobox `Checkout / machine` reads `<host> · <path>`.
  - The sidebar has searchbox `Find instruction or skill file`, nav `Instruction and skill files` with tree `Instruction and skill file tree` (treeitems `.bb` › `AGENTS.md`, `AGENTS.md`, `CLAUDE.md`, listed even when a file is missing), textbox `New instruction or skill file path`, and a disabled `New file`.
  - Click treeitem `AGENTS.md` (level 1) by ref, or open `$URL/plugins/agent-instructions/instructions/projects/<project-id>/<source-id>/AGENTS.md`. Region `File editor` shows heading `AGENTS.md`, `Revert`, `Save`, the mode radios, and textbox `AGENTS.md`; the page's kicker is `Project source`.
  - Edit: choose `Markdown source`, `find role textbox fill "# verify AGENTS edited" --name "AGENTS.md"`, and `find role button click --name "Save" --exact`. `wait --text "Saved"` passes, and `cat "$FX/verify-ai/AGENTS.md"` prints the edit, with no trailing newline.
  - New file: `find role textbox fill ".agents/skills/verify-proj/SKILL.md" --name "New instruction or skill file path"` and `find role button click --name "New file" --exact`. The URL ends in that path, and the editor shows `This file does not exist yet. Save to create it.` Fill it with frontmatter (`name: verify-proj`, `description: …`) and save. The file exists in the checkout, and the tree gains `.agents / skills / verify-proj` › `SKILL.md`.
  - Conflict: on `AGENTS.md`, fill a draft without saving, run `echo shell-edit >> "$FX/verify-ai/AGENTS.md"`, then choose `Save`. `wait --text "File changed on disk. Your draft is kept."` passes, and the alert offers `Discard draft and reload`, which loads the disk text.
- **Plugin prompts (`ai-prompts-list`, `ai-prompts-edit`).** This uses at-plugin's `instructions/installed-plugin.md`, which has placeholders `{{name}}` and `{{pluginId}}`.
  - Confirm the write lands in the test copy and keep the original: `SP=$("$TB" plugin source at-plugin | sed -n 's/^ *resolved: path://p')` must be under `$INST/src`; stop if it is not. `cp "$SP/instructions/installed-plugin.md" "$EV/installed-plugin.orig.md"`.
  - Run `agent-browser --session "$RUN" open "$URL/plugins/agent-instructions/instructions/prompts/at-plugin/file/instructions/installed-plugin.md"` and `agent-browser --session "$RUN" wait --text "Installed Plugin Mentions"`. The kicker reads `Prompt · Installed Plugin Mentions`.
  - The sidebar nav `Plugins` lists editable plugins first, as `<name> [N tools · ]N files` (`Installed Plugin Mentions 1 file`, expanded, with a `Prompts` heading and row `installed-plugin.md`), then every other plugin as `<name> read-only`. The editor shows heading `instructions/installed-plugin.md`, `Revert`, `Save & reload`, textbox `instructions/installed-plugin.md`, `{{name}}` and `{{pluginId}}` chips, and `331 chars`.
  - Placeholder guard: choose `Markdown source`, then `find role textbox fill "$(sed 's/{{name}}//' "$EV/installed-plugin.orig.md")" --name "instructions/installed-plugin.md"` and `find role button click --name "Save & reload"`. `wait --text "Put back {{name}}"` passes; the notice reads `The plugin's code fills a fixed set of placeholders. Put back {{name}}.` `diff "$SP/instructions/installed-plugin.md" "$EV/installed-plugin.orig.md"` prints nothing.
  - Successful save: choose `Revert`, fill the textbox with `"$(cat "$EV/installed-plugin.orig.md") VERIFY"`, and choose `Save & reload`. `wait --text "reloaded with the new text"` passes; the notice reads `Saved. Installed Plugin Mentions reloaded with the new text.` The `diff` shows ` VERIFY` on the last line.
  - The edited text reaches the agent: on the free-agent thread, insert a `#Vimium` pill and send ([Installed Plugin Mentions](at-plugin.md) **Resolve on send**). `thread output` ends the reference with `… establishes no execution order. VERIFY`.
  - Restore: fill the original text and `Save & reload`, then confirm the `diff` is empty and the doctor passes `--plugin at-plugin`.
  - Read-only plugins: expand `bb account read-only` and choose its `SKILL.md`. The editor says `Installed from builtin · bb-account. Install it from a local checkout to edit it.`, and `Save & reload` stays disabled.
  - Tools: `Source Control 6 tools · 29 files` lists `Tools` (`source_control_report_findings`, `source_control_write_guide`, `source_control_share_change` with a `thread snippet` row, …) and `Prompts`.
- **Phone layout (`ai-phone`).**
  - Run `agent-browser --session "$RUN" set viewport 390 844 3`, then `agent-browser --session "$RUN" open "$URL/plugins/agent-instructions/instructions"`. The page shows nav `Instruction editors` above nav `Catalog`, with the `Folder:` source path and expandable sync conflicts in the status line.
  - Open `$URL/plugins/agent-instructions/instructions/global/rules`. Nav `Instruction location` holds a `Back to Global` button (drawn as `‹ Global`), above the rules text and `Add rule`.
  - Restore with `agent-browser --session "$RUN" set viewport 1920 1080 2`. Use `scripts/phone-shot.ts` for edge checks.
- **Proof.** Before and after each write, run `agent-browser --session "$RUN" screenshot "$EV/ai-<state>.png"`, `ls -la "$INST/data/skills" "$INST/data/AGENTS.md" > "$EV/ai-usertier-<state>.txt" 2>&1`, and `"$TB" agent-instructions catalog --json > "$EV/ai-catalog-<state>.json"`.
- **Cleanup.**
  - Delete every fixture skill and doc with `skill delete` / `doc delete` and `--expect` (or remove fixture files from `$SRC`). Reload the Global page, then for each `Recently deleted` entry choose `Remove` and `Remove for good`.
  - Remove fixture rules with `"$TB" agent-instructions remove <id>`, and clear any fixture files under `$SRC/conflicts/`.
  - Run `"$TB" agent-instructions publish`, which then prints `0 added, 0 updated, 0 removed, 0 unchanged` and `not published: no enabled global instructions`. `ls -la "$INST/data/skills" "$INST/data/AGENTS.md"` must match `$EV/ai-usertier-before.txt` apart from directory timestamps, and `catalog --json` must show no docs, skills, or conflicts.
  - Restore at-plugin's prompt file as above.
  - Run `"$TB" project delete <project-id> --yes`, then remove `$FX`.

## Gotchas

- Publishing writes into the test instance's data dir, `$INST/data`, never live's. It creates relative links `skills/<name>` and `AGENTS.md` that point into `$INST/data/plugins/agent-instructions/`. Never run these recipes against a bare `bb`: live's catalog holds every real skill and its global text.
- A user-tier entry the plugin did not make blocks its name: the row shows a `clash` badge, and `publish` exits 1 with `… already exists and this plugin did not make it, so it was left alone`. This is correct behavior, not a gap.
- `Publish` in the status line appears only in a warn or bad state. After a clean publish the line reads `Published` with no button.
- The shadow check lists skills through a project, so with no project it silently allows any name. A fresh instance may also have built-in plugins such as `bb--mcp` disabled, which hides their skills from the check. Create the fixture project first.
- `source/` edits and CLI writes emit `sourceChanged` realtime updates: an open unmodified editor refreshes automatically, while an unsaved draft surfaces the conflict banner instead of discarding typed text.
- `conflicts/` files are synced across hosts for easy diff/merge and are intentionally excluded from `AGENTS.md`, rules, and published skills.
- Rules autosave about 0.5 s after the last keystroke. Wait for the `Saved` output before reading `list --json`. `Delete <rule>` has no confirmation.
- `preview` only knows sessions seen since the plugin last loaded. A `plugin reload` or bb restart clears them.
- Markdown fields default to rich text, a contenteditable `textbox`. `fill` is reliable only after you choose the `Markdown source` radio, which shows a plain textarea with the same accessible name.
- Several buttons share a name with a dialog's action (`Delete doc`, `Delete file`, `Create`, `Save`, `Remove`). Use `--exact` or the dialog's ref from `snapshot -i -c`.
- `Save & reload` in Plugin prompts writes into whatever directory bb loads the plugin from, then reloads it. Check `"$TB" plugin source <id>` resolves under `$INST/src` first, or the edit lands in a real checkout. `plugin source` prints several lines; read the `resolved: path:` line. Until the file is restored, the doctor's "copy matches the checkout" check fails for that plugin, so restore it explicitly and check with `diff`.
- Headless Chrome has `(hover: none)`. Skill rows show their description in a hover `Hint`, which cannot be checked here.
