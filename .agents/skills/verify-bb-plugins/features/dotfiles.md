# Dotfiles

Dotfiles turns one git-tracked dotfiles repository into an editing console. A **Dotfiles** nav panel has a sidebar with three sections: Files, Workflows, and Tasks. Files lists the repo's fixed config files and its discovered skills, with dirty and missing markers. A file opens in an editor beside a diff against `HEAD`, and saves use a hash check that refuses to overwrite a file changed on disk. Tasks runs the repo's `mise` tasks and shows their output. `bb dotfiles` prints the same file list, git status, and files, and runs the same tasks from a shell. Every read, save, and task runs on one machine: the one picked in the panel, or the calling thread's machine.

## Sub-features

- `dot-panel` opens the Dotfiles nav panel. Its header badge reads `<machine> · <branch> · clean` or `· N dirty`.
- `dot-empty-states` shows `No dotfiles repository at <path>.` for a missing repo, `<machine> is not connected.` for an offline machine, and `Select a file in the sidebar's Files or Workflows section.` when no file is selected.
- `dot-sections` switches the sidebar between `Files`, `Workflows`, and `Tasks`, and remembers the choice across reloads.
- `dot-file-list` lists the groups `Agent config`, `Settings overlays`, `Shell`, `Mise`, `Repo policy`, and `Skills` under Files, and `Engineering workflows` under Workflows. It shows the branch and dirty count, the machine picker, and the absolute repo path. Rows mark a dirty file with `uncommitted changes` and an absent file with `missing`, and a missing row is disabled.
- `dot-host-picker` picks the machine in the `Machine` select and stores it in the `hostId` setting.
- `dot-instruction-links` sends instruction, skill, workflow, and `AGENTS.md` rows to Agent Instructions instead of the editor.
- `dot-editor` opens a file at `/plugins/dotfiles/dotfiles/<path>` in a source editor. It saves on `Ctrl+S`, on blur, and on leaving the file, and shows the status `Unsaved changes`, `Saving…`, or `Saved`. Header **Reload** reloads the file from disk; a mouse click saves the draft first (blur save), so it does not discard it.
- `dot-diff` toggles **Source** and **Diff**. Diff shows a split diff of `HEAD` against the working text, or the plain source when they match.
- `dot-conflict` refuses a save when the file changed on disk since it was opened. It shows status `Conflict` and a `Changed on disk.` banner with **Reload** and **Overwrite**.
- `dot-render-stale` shows `Rendered files are stale.` with **Run render** after a save to a file that renders, such as `.dotfiles/mcp.json`. A successful render or publish clears it.
- `dot-tasks` runs `render`, `Refresh agent skills`, `check`, `apply:dry`, and `sync:pull` from Tasks. It shows `<task> on <machine> — running…`, then `— exit N` with the output and **Dismiss**, and a toast.
- `dot-publish` makes the destructive `sync` button ask in a `Publish` dialog first (`This rebases onto origin/main and pushes.`), then runs the publish task.
- `dot-remove-skill` puts a `Remove skill <name>` button on each skill row. It opens a `Remove skill` dialog, and confirming runs `npx skills remove <name> -g -y` on that machine.
- `dot-path-guard` refuses to read or save any path outside the file list (`not a tweakable file: <path>`), in the panel and the CLI.
- `dot-cli` covers `bb dotfiles list|status|cat <path>|render|check [target]|sync [--publish]`. Each prints `host: <machine> · repo: <path>` on stderr.
- `dot-settings` covers **Dotfiles repo path** (`repoPath`, default `~/git/dotfiles`) and **Machine (bb host id)** (`hostId`) under Settings → Plugins → Dotfiles. A new `repoPath` takes effect on the next request; an open panel keeps its old state until reopened.
- `dot-telemetry` sends scrubbed Sentry error and timing reports, controlled by the **Send anonymous crash and performance reports** setting (`telemetry`, on by default). <!-- unverified: added from a source audit, not driven -->

## How to get to it (user POV)

- Open **Dotfiles** from bb's sidebar navigation: it is not pinned, so choose `More` (`find role button click --name "More" --exact`), then the menuitem `Dotfiles`. The panel is at `/plugins/dotfiles/dotfiles`, and a file deep link is `/plugins/dotfiles/dotfiles/<repo-relative path>` (for example `…/.dotfiles/.gitconfig`).
- The panel's left sidebar has the `Dotfiles sections` tabs `Files`, `Workflows`, and `Tasks`. The Files header holds the `Machine` select.
- In the editor, type, then press `Ctrl+S` or move focus away to save. Use the `File view` toggle for **Source** and **Diff**.
- Run `bb dotfiles <command>` from a shell. Outside a thread it acts on the panel's machine; in a thread, on the thread's machine.
- Open **Settings → Plugins → Dotfiles** (`/settings/plugins/dotfiles`) for **Dotfiles repo path** and **Machine (bb host id)**.

## Driving it with agent-browser

Preconditions:

- Live has Dotfiles enabled, so the test instance installed it from the source copy and left it disabled: `"$TB" plugin list --json | jq -c '.plugins[] | select(.id=="dotfiles") | {enabled,status,source}'` prints `enabled:false`, `status:"disabled"`, and `source:"path:$INST/src/plugins/dotfiles"`. If live lacks it, install it with `"$TB" plugin install --yes "$INST/src/plugins/dotfiles"`. <!-- unverified: the install route, not needed here -->
- `mise` and `git` are on PATH in the test host daemon's login shell (fish here). Tasks fail with exit 127 otherwise.
- **The fixture repository.** Build a disposable repo in the plugin's layout whose `mise` tasks only echo. Do not clone `~/git/dotfiles`: its real `render`, `sync:pull`, and `install:*` tasks write into the user's home and push to GitHub. `.dotfiles/.config/starship.toml` is left out on purpose, so its row reads `missing`.

  ```bash
  FX="$BB_THREAD_STORAGE/verify/$RUN-fixtures"; DF="$FX/verify-dotfiles"; mkdir -p "$DF"
  ( cd "$DF" && git init -q -b main
    mkdir -p .dotfiles/.agents/instructions .dotfiles/.agents/plugins/scott-engineering/skills/dev/playbooks \
      .dotfiles/.agents/skills/verify-fixture-skill .dotfiles/.claude .dotfiles/.codex .dotfiles/.config/fish .dotfiles/.config/mise
    printf '{\n  "mcpServers": {}\n}\n' > .dotfiles/mcp.json
    for f in shared claude codex; do printf '# %s instructions (verify fixture)\n' "$f" > ".dotfiles/.agents/instructions/$f.md"; done
    printf '# dev skill (verify fixture)\n' > .dotfiles/.agents/plugins/scott-engineering/skills/dev/SKILL.md
    printf '# bug fix (verify fixture)\n' > .dotfiles/.agents/plugins/scott-engineering/skills/dev/playbooks/bug-fix.md
    printf -- '---\nname: verify-fixture-skill\ndescription: verify fixture\n---\n' > .dotfiles/.agents/skills/verify-fixture-skill/SKILL.md
    printf '{}\n' > .dotfiles/.claude/settings.overlay.json
    printf '# overlay (verify fixture)\n' | tee .dotfiles/.codex/config.macos.overlay.toml > .dotfiles/.codex/config.linux.overlay.toml
    printf '# fish (verify fixture)\n' > .dotfiles/.config/fish/config.fish
    printf '[user]\n\tname = verify fixture\n' > .dotfiles/.gitconfig
    printf '# mise (verify fixture)\n' | tee .dotfiles/.config/mise/config.toml mise.macos.toml mise.linux.toml > .miserc.toml
    printf '# AGENTS.md (verify fixture)\n' > AGENTS.md
    for t in render install:agent-plugins check:live check check:location check:mise check:shell check:mcp \
      check:python check:skills check:dotfiles check:safety check:secrets sync:pull sync; do
      printf '[tasks."%s"]\nrun = "echo verify-%s-ok"\n\n' "$t" "$t"; done > mise.toml
    git add -A && git -c user.name=verify -c user.email=verify@example.invalid commit -qm init )
  ```

- **Do not run `mise trust`.** It writes under `~/.local/state/mise`, and the fixture's echo tasks ran without it on this host. Gate on the first task instead (below).
- **Enable and point at the fixture, in this order.** bb serves a plugin's settings only while the plugin runs: `plugin config dotfiles set repoPath …` while disabled exits 1 with `unknown plugin, or plugin is not running — settings exist once its factory has run`. Enabling registers only RPC and CLI (no service, schedule, or nav badge reads the repo), so nothing touches the default path until a request arrives. Run enable and set in one shell line with no browser on a Dotfiles page, and run no `"$TB" dotfiles` in between, because the default path is the user's real repo.

  ```bash
  "$TB" plugin enable dotfiles && "$TB" plugin config dotfiles set repoPath "$DF"
  "$TB" plugin config dotfiles --json | jq -c .values   # {"repoPath":"<$DF>"}; hostId is absent (unset)
  ```

  Then run the doctor with `--plugin dotfiles`.

- **Gate the tasks.** Run `"$TB" dotfiles check mise`. It must print `[check:mise] $ echo verify-check:mise-ok`, `verify-check:mise-ok`, and the `host: … · repo: <$DF>` line, with exit 0. If it prints anything else (a trust error, or real validator output), run no task recipe below.
- Record the test machine for later checks: `"$TB" plugin rpc call dotfiles hosts --json` prints `{"selectedHostId":"<host-id>","hosts":[{"id":"<host-id>","name":"<machine>","connected":true}]}`. Write `{}` to `"$FX/empty.json"` for the `overview` read-back below.

Panel and CLI:

- **Panel (`dot-panel`, `dot-empty-states`).** Run `agent-browser --session "$RUN" open "$URL/plugins/dotfiles/dotfiles"` and `agent-browser --session "$RUN" wait --text "Select a file in the sidebar's Files or Workflows section." --timeout 15000`. The header badge reads `<machine> · main · clean`. Also reach it the user's way from Home: `agent-browser --session "$RUN" find role button click --name "More" --exact`, then `agent-browser --session "$RUN" find role menuitem click --name "Dotfiles"`.
- **File list (`dot-file-list`).** Run `agent-browser --session "$RUN" snapshot -i -c > "$EV/dot-files.snapshot.txt"`. It shows the groups `Agent config`, `Settings overlays`, `Shell`, `Mise`, `Repo policy`, and `Skills` (rendered uppercase), and the row `verify-fixture-skill` under Skills. The sidebar header reads `main` and `clean`, followed by the `Machine` combobox (`<machine>`) and the absolute path of `$DF`. Editor rows are buttons (`MCP servers`, `Claude settings overlay`, `Codex overlay (macOS)`, `Codex overlay (Linux)`, `fish config`, `.gitconfig`, `mise.toml`, `mise.macos.toml`, `mise.linux.toml`, `.miserc.toml`, `Global mise config`); instruction rows are links (`Instructions: shared|claude|codex`, `AGENTS.md`, `verify-fixture-skill`). The button `starship prompt missing` is disabled.
- **Sections (`dot-sections`).** Run `agent-browser --session "$RUN" find role tab click --name "Workflows"`. The panel shows the hint `After saving, run Refresh agent skills in Tasks to update installed copies, then start a new agent session.`, `Engineering workflows`, `Engineering guide`, and `Bug fix`; every other playbook row reads `missing`. Choose the `Tasks` tab, reload with `agent-browser --session "$RUN" open "$URL/plugins/dotfiles/dotfiles"`, and run `agent-browser --session "$RUN" wait --text "Run a task to see its output."`. Tasks is still selected. Return to `Files`.
- **Instruction links (`dot-instruction-links`).** Under Agent config, choose `Instructions: shared` with `agent-browser --session "$RUN" find role link click --name "Instructions: shared"`. Then `agent-browser --session "$RUN" get url` starts with `$URL/plugins/agent-instructions/instructions/global/at/<host-id>/<url-encoded $DF>/.dotfiles/.agents/instructions/shared.md`. Open `"$URL/plugins/dotfiles/dotfiles/AGENTS.md"` directly: the page shows only the link `Edit instructions and skills in Agent Instructions`. Agent Instructions must be enabled on the test instance for the target to render.
- **Editor and save (`dot-editor`).** Choose `mise.toml` under Mise with `agent-browser --session "$RUN" find role button click --name "mise.toml" --exact`, then run `agent-browser --session "$RUN" wait --text "Saved"`. The URL ends `/plugins/dotfiles/dotfiles/mise.toml`, and the header has the `File view` radiogroup (`Source`, `Diff`), `Reload`, and the status. Focus the editor with `agent-browser --session "$RUN" focus '[aria-label="Edit mise.toml"][contenteditable]'`, then `agent-browser --session "$RUN" press Control+End` and `agent-browser --session "$RUN" keyboard type "# verify edit"`. The editor's label is `Edit <repo-relative path>`, for example `Edit .dotfiles/.gitconfig`. The status reads `Unsaved changes`. Press `Control+s` and wait for `Saved`.
  - Prove the save on disk with `tail -n1 "$DF/mise.toml"`, which prints the edit.
  - The row's name becomes `mise.toml uncommitted changes` (a dot marker), and the header badge reads `<machine> · main · 1 dirty`.
  - `"$TB" dotfiles status` prints `branch: main` and `M  mise.toml`.
- **Diff (`dot-diff`).** Run `agent-browser --session "$RUN" find role radio click --name "Diff"`. A split diff (`41 unmodified lines` collapsed, the added line in green on the right) renders inside a shadow root, so `innerText` and snapshots do not show it; take a screenshot. Choose `find role radio click --name "Source"`: the edit is still in the editor. Then open `.gitconfig`, which is unchanged, and choose Diff: it shows the plain numbered source with no diff.
- **Reload with unsaved edits.** In `fish config`, type `# unsaved` and do not save (status `Unsaved changes`). Choose `find role button click --name "Reload" --exact`. Observed: the blur save wins, so the status reads `Saved`, the editor still holds `# unsaved`, and `git -C "$DF" diff --stat .dotfiles/.config/fish/config.fish` shows `1 insertion(+)`. A mouse click on Reload cannot discard a draft (product gap). Restore the fixture file from the shell afterwards.
- **Conflict (`dot-conflict`).** Open `.gitconfig`, focus the editor, and type `# draft` without leaving the editor. From the shell run `printf '# changed on disk\n' >> "$DF/.dotfiles/.gitconfig"`, then press `Control+s` in the browser. The status reads `Conflict`, and the banner `Changed on disk.` has `Reload` and `Overwrite` buttons (the header's `Reload` is a second button of the same name). Choose `Overwrite` with `agent-browser --session "$RUN" find role button click --name "Overwrite"` and wait for `Saved`. `cat "$DF/.dotfiles/.gitconfig"` now holds the draft, not the line written on disk.
- **Render stale (`dot-render-stale`).** Open `MCP servers` (`.dotfiles/mcp.json`), press `Control+End`, type a space, and press `Control+s`. The banner `Rendered files are stale.` appears with a `Run render` button. Choose `Run render`: the toast `render succeeded on <machine>` appears and the banner clears. In the Tasks tab, the output reads `render on <machine> — exit 0`, `[render] $ echo verify-render-ok`, and `verify-render-ok`.
- **Tasks (`dot-tasks`).** The Tasks tab has buttons `render`, `Refresh agent skills`, `check`, `apply:dry`, `sync:pull`, and `sync`, the line `Runs on <machine>`, and `Run a task to see its output.`. Choose `check`, `sync:pull`, and `Refresh agent skills` one at a time (`find role button click --name "<task>" --exact`). Wait for `— exit` after each: tasks buffer output until they end and are killed at 300 s. Each prints `<task> on <machine> — exit 0`, a `[<task>] $ echo verify-<task>-ok` line, and `verify-<task>-ok`, with a toast `<task> succeeded on <machine>`. `Refresh agent skills` is titled `install:agent-plugins on <machine>` and prints both `verify-install:agent-plugins-ok` and `verify-check:live-ok`. Choose the panel's `Dismiss` by its snapshot ref (a name match can hit a toast first): the output area returns to `Run a task to see its output.`
  - `apply:dry` runs `mise dotfiles apply --dry-run --verbose`, not a fixture task; it resolves the real global mise mappings, so it was not run. <!-- unverified: apply:dry -->
- **Publish (`dot-publish`).** Choose `sync`. The `Publish` dialog reads `Publish from <machine>? This rebases onto origin/main and pushes.` The dialog has `Cancel`, `Publish`, and `Close`. Choose `find role button click --name "Cancel" --exact` first: nothing runs. Choose `sync` again, then `find role button click --name "Publish" --exact`: the output reads `sync on <machine> — exit 0` and `verify-sync-ok`. Only the fixture's echo stub makes this safe.
- **Remove skill (`dot-remove-skill`).** Focus the skill's remove button with `agent-browser --session "$RUN" focus '[aria-label="Remove skill verify-fixture-skill"]'` and press `Enter`. The `Remove skill` dialog reads `Remove skill "verify-fixture-skill" via npx skills on <machine>? This deletes it for every agent on that machine.` Click `Cancel` by its snapshot ref (never a key press), and the dialog closes with the row intact. Do not choose `Remove`: it runs the global `npx skills remove -g` for the user's account on this machine, outside the fixture.
- **Machine picker (`dot-host-picker`).** Run `agent-browser --session "$RUN" find role combobox click --name "Machine"`. It lists one option per host, here only `<machine>` (selected). Choosing the already-selected machine stores nothing: `"$TB" plugin config dotfiles --json | jq -c .values` still has no `hostId`. Storing a different machine and the offline state need a second host, which the test instance does not have. <!-- unverified: hostId write and `<machine> is not connected.` need a second host -->
- **Path guard (`dot-path-guard`).** Open `"$URL/plugins/dotfiles/dotfiles/notes.txt"`. The page shows `not a tweakable file: notes.txt` and a `Retry` button. `"$TB" dotfiles cat .ssh/id_ed25519` exits 1 with `bb dotfiles failed: not a tweakable file: .ssh/id_ed25519`.
- **CLI (`dot-cli`).**
  - `"$TB" dotfiles list` prints `# Agent config`, `# Engineering workflows`, `# Settings overlays`, `# Shell`, `# Mise`, `# Repo policy`, and `# Skills`. Flags appear as `.dotfiles/mcp.json  [renders]` (`[dirty, renders]` after an edit), `mise.toml  [dirty]`, and `.dotfiles/.config/starship.toml  [MISSING]`. Stderr reads `host: <machine> · repo: <$DF>`.
  - `"$TB" dotfiles cat AGENTS.md` prints `# AGENTS.md (verify fixture)`.
  - `"$TB" dotfiles render`, `"$TB" dotfiles check mise`, `"$TB" dotfiles sync`, and `"$TB" dotfiles sync --publish` print `verify-render-ok`, `verify-check:mise-ok`, `verify-sync:pull-ok`, and `verify-sync-ok` (each after a `[<task>] $ echo …` line), and exit 0 with the task.
  - `"$TB" dotfiles check nope` exits 2 with `unknown check target: nope`.
  - Second view of the panel's state: `"$TB" plugin rpc call dotfiles overview --input-file "$FX/empty.json" --json` prints `state: "ready"`, `branch: "main"`, and `gitEntries` (one per dirty path).
- **Missing repo (`dot-empty-states`, `dot-settings`).** Open `"$URL/settings/plugins/dotfiles"` and wait for `Dotfiles repo path`. The page has bb's switch `Disable dotfiles` and textboxes `Dotfiles repo path` (the fixture path) and `Machine (bb host id)` (empty while unset). Run `"$TB" plugin config dotfiles set repoPath "$FX/absent"`. Then reopen `"$URL/plugins/dotfiles/dotfiles"`: it reads `No dotfiles repository at <$FX/absent>.`, and the badge reads `<machine> · no repository`. `"$TB" dotfiles list` fails with `dotfiles repo not found at <$FX/absent> on <machine>`. Set `repoPath` back to `"$DF"`: the open panel keeps showing the missing-repo text (waited 15 s); reopening the page shows the file list again.
- **Proof.** Capture `agent-browser --session "$RUN" screenshot "$EV/dot-<state>.png"` before and after each save, conflict, task, and dialog. Save CLI output to `"$EV/dot-cli-<command>.txt"`, keeping stderr.
- **Cleanup and restore.** `unset repoPath` re-points the running plugin at the real repo, so first leave every Dotfiles page (`agent-browser --session "$RUN" open about:blank`), then unset, read back, and disable in one line. If you disabled first, enable again with the fixture path still set and do the same.

  ```bash
  "$TB" plugin config dotfiles unset repoPath && "$TB" plugin config dotfiles unset hostId; "$TB" plugin config dotfiles --json | jq -c .values; "$TB" plugin disable dotfiles
  "$TB" plugin list --json | jq -c '.plugins[] | select(.id=="dotfiles") | {enabled,status}'   # {"enabled":false,"status":"disabled"}
  rm -rf "$DF"
  ```

  The read-back prints `{"repoPath":"~/git/dotfiles"}`, the default.

## Gotchas

- `bun scripts/test-instance.ts sync` disables Dotfiles again every time, because the `repoPath` default is a real path. After any sync mid-run, run `"$TB" plugin enable dotfiles` and confirm `repoPath` still reads `$DF` before driving. The setting survives the disable.
- `plugin config dotfiles set` answers `unknown plugin, or plugin is not running — settings exist once its factory has run` while the plugin is disabled, and `plugin config dotfiles --json` fails too. That is why the order is enable, then set.
- Only the fixture's echo tasks make `render`, `sync:pull`, `Refresh agent skills`, `sync`/Publish, and `bb dotfiles sync --publish` safe. Pointed at a clone of the real repo, they write the user's home and push.
- **Remove skill** acts globally, not on the fixture. The fixture's skill name keeps a misclick from removing a real skill, but the command still runs `npx` with network access.
- The editor saves on blur. Clicking any control, such as the Diff toggle or Reload, saves the draft first, so Reload never discards a draft by mouse. Keep focus in the editor for the conflict check, and write the disk change from the shell.
- Every `.md` row and deep link opens Agent Instructions, so the plugin's Markdown editor is unreachable from the UI.
- The remove-skill button has opacity 0 until hover or keyboard focus, and headless Chrome has no hover. It is in the accessibility tree; reach it by focus and `Enter`.
- `"$TB"` has no thread, so `bb dotfiles` acts on the panel's machine. The thread's-machine route needs a thread with an environment.
- The README describes Unified and Split diff views and a header **render** action. The panel has only a split Diff, and render lives in Tasks and the stale banner. Report the README, not the panel, as wrong.
- Task output is buffered until the task exits. A long `running…` is expected up to 300 s.
- The fixture's mise tasks ran without `mise trust` on this Linux host. If a host refuses them, stop: trusting writes under the real home.
- Changing `repoPath` does not refresh an open panel; reopen the page.
- Every file row name collides with others by prefix (`mise.toml` and `mise.macos.toml`, `sync` and `sync:pull`); use `--exact`.
- Running a fixture task writes mise task history under `~/.local/state/mise/task-history/<hash>/`, outside the fixture. After cleanup, remove the directories whose JSON names your fixture path, and nothing else.
