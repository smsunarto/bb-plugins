# Traces

Traces is a read-only explorer for Claude Code and Codex session files on a BB host. A sessions list, an event timeline, and an inspector show each recorded message, tool call, context block, and diagnostic, with formatted and raw views of the original JSONL record, filters by provider, event kind, and evidence topic, and keyboard navigation. It opens as a BB sidebar panel and as a Traces tab in a thread's right panel.

## Sub-features

- `traces-install` installs and enables the plugin on the test instance only, since live has it installed but disabled.
- `traces-nav` opens the Traces panel at `/plugins/traces/traces`.
- `traces-thread-tab` opens Traces as a tab in a thread's right panel from **New tab → Traces**.
- `traces-host-picker` switches the host whose session files are shown, from the `Trace host` select.
- `traces-sources` lists, adds, disables, and removes source folders or JSONL files in the `Trace sources` dialog, and shows the indexed counts.
- `traces-verify` re-audits every indexed record from **Verify sources** in the dialog.
- `traces-refresh` rescans from the toolbar **Refresh** button, which reads `Indexing…` while a scan runs.
- `traces-live-append` picks up lines appended to a source file without a manual refresh.
- `traces-sessions` lists sessions under `Sessions` with title, provider, workspace, time, event count, and error count; the `Search sessions` field and `Filter provider` select narrow the list.
- `traces-timeline` lists a session's events in `Trace events`, folds each tool result into its call row with a status badge, and labels each row with its source line `L<n>`.
- `traces-event-filters` narrows the timeline with `Search events`, `Filter event kind`, the `Usage` toggle, and the `Filter by topic` group.
- `traces-inspector` shows the selected event in `Event inspector` with its evidence, a formatted body, `Related events`, and a `Source · line <n>` provenance disclosure.
- `traces-raw` switches the inspector between `Formatted` and `Raw` (the original JSONL record, paged in 64 KiB chunks when large).
- `traces-diagnostic` shows a malformed source line as a `Malformed source record` event with raw access.
- `traces-keyboard` drives panes with `j`/`k`, arrows, `Home`/`End`, `Enter`, `Esc`, `/`, `r`, and `?`, which opens the `Keyboard shortcuts` dialog.
- `traces-splitters` resizes the session list and timeline with the `Resize the session list` and `Resize the timeline` separators, remembers the size across reloads, and resets on double-click. Collapsing the session list shows a `Sessions` button that restores it.
- `traces-stacked` shows one pane at a time with `Back to sessions` and `Back to timeline` buttons when the Traces container is narrower than 700px.
- `traces-pages` pages sessions (50) and events (100) with `Previous page` and `Next page`.
- `traces-thread-scope` limits the list to the current BB thread's provider session with the `This BB thread only` checkbox in the thread tab.
- `traces-rpc` answers the same reads over the plugin RPC (`overview`, `status`, `sessions`, `events`, `event`, `raw`, `scan`, `configureSources`).

Traces registers no settings page, CLI command, agent tool, command palette entry, content script, or message directive. Its `/plugins/traces` settings page shows only bb's generic plugin information.

- `traces-periodic-scan` rescans sources every minute and audits every record every ten minutes. <!-- unverified: added from a source audit, not driven -->
- `traces-long-strings` cuts a long string in the Raw view at 2,000 characters, with `Show N characters` and `Collapse string`. <!-- unverified: added from a source audit, not driven -->

## How to get to it (user POV)

- Open **Traces** from BB's sidebar navigation: choose `More` (`find role button click --name "More" --exact`), then the menuitem `Traces`. Or go to `/plugins/traces/traces`.
- In a thread, open the right panel (`Show right panel (Ctrl + \)` in the thread header), choose `New tab`, then the `Traces` button among the panel's actions (`Task`, `Document`, `Review`, `Traces`).
- In the Traces toolbar, choose the `Trace host` select, **Sources**, **Refresh**, and the **Keyboard shortcuts** (`?`) button.
- Select a session row, then an event row. Press `Enter` to move right a pane and `Esc` to move back.
- Over RPC: `bb plugin rpc call traces <method> --input-file <json> --json`.

## Driving it with agent-browser

Preconditions:

- The doctor passes. It cannot check `--plugin traces` until the plugin is installed, so run it without `--plugin` first and with `--plugin traces` after the install below. If it reports `plugin traces source copy is stale`, the instance's copy lags the checkout, usually because the checkout has uncommitted Traces edits; `sync` copies them, and until then labels below describe the instance's copy.
- The test instance runs on this machine, so its host daemon sees this user's real `~/.claude/projects`, `~/.codex/sessions`, and `~/.codex/archived_sessions`. Those are the default sources. Replace them with a fixture before capturing evidence, as below, so screenshots hold no private session titles.
- **Install (`traces-install`).** Live has Traces installed but disabled, so `sync` never installs it here. Install from the instance's source copy and enable it:

  ```bash
  "$TB" plugin install --yes "$INST/src/plugins/traces"   # prints traces@0.1.0  running; install also enables it
  "$TB" plugin list --json | jq -c '.plugins[] | select(.id=="traces") | {enabled, source, status}'
  ```

  The list prints `enabled: true`, `status: "running"`, and a `path:` source under `$INST/src/plugins/traces`. Run the fixture step below before any other Traces call or page: installing registers no service and `overview` reads only bb's host list, but the first `status`, `sessions`, or page load starts a scan of the default (real) sources, while a first `configureSources` does not. Run the doctor with `--plugin traces` after the fixture step.

- **Fixture source.** Write a disposable Claude Code session file, then point Traces at its folder alone. Record the host id:

  ```bash
  FX="$BB_THREAD_STORAGE/verify/$RUN-fixtures"; mkdir -p "$FX/claude" "$FX/rpc"
  S=22222222-2222-4222-8222-222222222222; C=/tmp/verify-traces
  cat > "$FX/claude/verify-traces.jsonl" <<EOF
  {"type":"custom-title","customTitle":"verify-traces fixture","uuid":"v0","sessionId":"$S","cwd":"$C","timestamp":"2026-11-24T10:00:00.000Z"}
  {"type":"user","uuid":"v1","sessionId":"$S","cwd":"$C","timestamp":"2026-11-24T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"List the fixture files"}]}}
  {"type":"assistant","uuid":"v2","sessionId":"$S","cwd":"$C","timestamp":"2026-11-24T10:00:02.000Z","message":{"role":"assistant","model":"claude-fixture-model","content":[{"type":"tool_use","id":"verify-bash","name":"Bash","input":{"command":"ls"}}]}}
  {"type":"user","uuid":"v3","sessionId":"$S","cwd":"$C","timestamp":"2026-11-24T10:00:03.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"verify-bash","content":"verify.txt","is_error":false}]}}
  {"type":"assistant","uuid":"v4","sessionId":"$S","cwd":"$C","timestamp":"2026-11-24T10:00:04.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"verify-search","name":"WebSearch","input":{"query":"verify traces"}}]}}
  {"type":"user","uuid":"v5","sessionId":"$S","cwd":"$C","timestamp":"2026-11-24T10:00:05.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"verify-search","content":"search failed","is_error":true}]}}
  {"type":"assistant","uuid":"v6","sessionId":"$S","cwd":"$C","timestamp":"2026-11-24T10:00:06.000Z","message":{"role":"assistant","id":"msg-verify","content":[{"type":"text","text":"Found verify.txt."}],"usage":{"input_tokens":12,"output_tokens":3}}}
  this line is not json
  EOF
  echo '{}' > "$FX/rpc/empty.json"
  "$TB" plugin rpc call traces overview --input-file "$FX/rpc/empty.json" --json | tee "$EV/traces-overview.json" | jq -r '.hosts[] | "\(.id) \(.name) \(.online)"'   # reads bb's host list only, no scan
  H=<host-id>   # the online host printed above
  jq -n --arg h "$H" --arg p "$FX/claude" '{hostId:$h, roots:[{provider:"claude-code", path:$p, enabled:true}]}' > "$FX/rpc/sources.json"
  "$TB" plugin rpc call traces configureSources --input-file "$FX/rpc/sources.json" --json | jq '{sessions, events, roots: [.roots[] | {path, state}]}'
  jq -n --arg h "$H" '{hostId:$h}' > "$FX/rpc/host.json"
  "$TB" plugin rpc call traces status --input-file "$FX/rpc/host.json" --json | jq '{sessions, events, scanning}'
  ```

  The first reply shows the root `state: "scanning"` with `sessions: 0`; repeat `status` until `scanning` is `false`, `sessions` is `1`, and `events` is `9`. `plugin rpc list traces` prints `No discoverable RPC methods.`, but `plugin rpc call` works and prints the bare result.
  The fixture holds eight lines. Tool results fold into their call rows, and the usage record stays hidden until **Usage** is on.

- **Open the panel (`traces-nav`).** Run `agent-browser --session "$RUN" open "$URL/plugins/traces/traces"` and `agent-browser --session "$RUN" wait --text "verify-traces fixture" --timeout 20000`. The toolbar shows searchbox `Search sessions`, combobox `Filter provider` (`All providers`), searchbox `Search events`, combobox `Filter event kind` (`All events`), button `Usage`, radiogroup `Filter by topic` (`Everything`, `Instructions`, `Skills`, `Plugins`, `Sandbox`, `Subagents`, `MCP`, `Search`), combobox `Trace host`, **Sources**, **Refresh**, and **Keyboard shortcuts**. At this width the session row is auto-selected, so the timeline heading reads `verify-traces fixture · Claude Code · claude-fixture-model`.
- **Session row (`traces-sessions`).** Run `agent-browser --session "$RUN" snapshot -i -c -s '[aria-label="Trace sessions"]'`. The one row is a button named `verify-traces fixture Claude Code verify-traces <date, time> 9 events 2 errors`: the error count includes the failed WebSearch result and the malformed line.
- **Session filters.** Run `agent-browser --session "$RUN" find role searchbox fill "no-such-session" --name "Search sessions"` and `agent-browser --session "$RUN" wait --text "No matching sessions" --timeout 5000`. Clear it by clicking the field and pressing `Control+a`, `Backspace`: `find role searchbox fill ""` leaves the text in place. Then click the `Filter provider` combobox (options `All providers`, `Claude Code`, `Codex`), `agent-browser --session "$RUN" find role option click --name "Codex"`, and the list reads `No matching sessions`. Set it back to `All providers` the same way; the fixture row returns. Click the combobox by snapshot ref once it shows a value; `find role combobox --name "Filter provider"` failed to match after a pick.
- **Timeline (`traces-timeline`).** Run `agent-browser --session "$RUN" snapshot -i -c -s '[aria-label="Trace events"]'`. The heading reads `verify-traces fixture · Claude Code · claude-fixture-model`, and the six rows are `Session title … L1`, `user … List the fixture files L2`, `Bash SUCCESS … ls L3`, `WebSearch ERROR … verify traces invoked · Native web search L5`, `assistant … Found verify.txt. L7`, and `Malformed source record Unexpected token 'h', "this line i"... is not valid JSON this line is not json L8`. No row is a bare tool result. Times show in the browser's local zone. <!-- unverified: a `2 tools · 1 errors` heading counter; not seen in the instance's copy -->
- **Event filters (`traces-event-filters`).**
  - **Kind.** Run `agent-browser --session "$RUN" find role combobox click --name "Filter event kind"` and `agent-browser --session "$RUN" find role option click --name "tool call"`. The options are `All events`, `message`, `reasoning`, `tool call`, `tool result`, `context`, `turn`, `usage`, and `diagnostic`. Only `Bash` and `WebSearch` remain, without their result badges. Choose `All events` to restore.
  - **Usage.** Run `agent-browser --session "$RUN" find role button click --name "Usage"`. A `Response usage` row appears and the button's `aria-pressed` is `true` (read it with `eval`; the snapshot omits it). Choose it again to hide that row.
  - **Topic.** Run `agent-browser --session "$RUN" find role radio click --name "Search"`. Only the `WebSearch` row remains, with `Native web search` in its summary. Choose `Everything` to restore.
  - **Search.** Click `Search events` and `keyboard type "verify.txt"`. The list narrows to `Tool result … verify.txt L4` (shown on its own row while searching) and `assistant … Found verify.txt. L7`. Clear the field with `Control+a`, `Backspace`.
- **Inspector (`traces-inspector`).** Run `agent-browser --session "$RUN" find role button click --name "Bash SUCCESS"`. `Event inspector` shows the radiogroup `Record view` (`Formatted`, `Raw`), the eyebrow `ASSISTANT`, the heading `Bash` with a `Bash` chip and `requested`, `COMMAND` with `ls`, `RESULT · SUCCESS` with `verify.txt`, and `RELATED EVENTS` listing `↙ Tool result L4`. Choose `▸ Source · line 3` to expand provenance: `Path` ends in `verify-traces.jsonl`, `Record pointer` is `/message/content/0`, and `Event ID`, `Bytes` (`422 + 302`), and `Record SHA-256` are filled.
- **Raw (`traces-raw`).** In the inspector, run `agent-browser --session "$RUN" find role radio click --name "Raw"`. The body reads `Original JSONL · 302 bytes` above a collapsible JSON tree (`6 keys`, `"type": "assistant"`, …). Choose `Formatted` to return. Pressing `r` with focus in the Traces panel toggles the same view.
- **Diagnostic (`traces-diagnostic`).** Choose the `Malformed source record` row. The inspector stays on `Formatted` and shows `DIAGNOSTIC`, `Malformed source record`, `diagnostic`, the text `this line is not json`, and `Source · line 8`.
- **Live append (`traces-live-append`).** Run `echo '{"type":"user","uuid":"v7","sessionId":"22222222-2222-4222-8222-222222222222","cwd":"/tmp/verify-traces","timestamp":"2026-11-24T10:00:07.000Z","message":{"role":"user","content":[{"type":"text","text":"appended verify line"}]}}' >> "$FX/claude/verify-traces.jsonl"`, then `agent-browser --session "$RUN" wait --text "appended verify line" --timeout 15000`. The new row appears without pressing **Refresh** (here in under a second), since the host watches the folder.
- **Refresh (`traces-refresh`).** Run `agent-browser --session "$RUN" find role button click --name "Refresh"`. The button reads `Indexing…` and is disabled while the scan runs, then returns to `Refresh`. A fast scan finishes before even an `eval` 50 ms after the click catches `Indexing…`; on the one-file fixture it was not observed. <!-- unverified: the Indexing… label -->
- **Sources (`traces-sources`, `traces-verify`).**
  - **Open.** Run `agent-browser --session "$RUN" find role button click --name "Sources"` and `agent-browser --session "$RUN" wait --text "Trace sources"`. The dialog reads `Read Claude Code and Codex session files on this host. Source files are never modified.`, lists the fixture folder with checkbox `Claude Code`, a `ready` badge, and **Remove source**, then an add row (combobox `Provider`, textbox `Folder or JSONL file`, **Add source**), and the footer `1 sessions · 10 events indexed` with **Verify sources**, **Cancel**, and **Save sources**.
  - **Add validation.** Fill `Folder or JSONL file` with a relative path: `agent-browser --session "$RUN" find label "Folder or JSONL file" fill "relative/path"`, then `agent-browser --session "$RUN" find role button click --name "Add source"`. The alert reads `Use an absolute path on the selected host.`
  - **Add a file source.** Fill the same field with `$FX/claude/verify-traces.jsonl` (expanded) and choose **Add source**. A row with a `New` badge appears. Choose `find role button click --name "Cancel" --exact`, reopen **Sources**, and the `New` row is gone, since nothing was saved.
  - **Disable and save.** Uncheck the fixture row's `Claude Code` checkbox and choose **Save sources**. The dialog closes. `"$TB" plugin rpc call traces status --input-file "$FX/rpc/host.json" --json | jq '.roots[] | {path, enabled, state}'` prints `enabled: false` and `state: "disabled"`, and `sessions` stays `1` because a disabled source keeps its cached traces. Re-enable it and save.
  - **Verify.** Reopen **Sources** and choose **Verify sources**. It reads `Verifying…` while the audit runs (caught by an `eval` 60 ms after the click), then `Verify sources` again.
  - **Remove** is covered under Cleanup: removing a source deletes its index entries, not the file.
- **Keyboard (`traces-keyboard`).** Focus the session row with `agent-browser --session "$RUN" focus '[id^="tr-session-"]'` (its id is `tr-session-<.items[].id from the sessions RPC>`), then press `Enter`. Focus moves to the timeline's selected row. Press `j` and `k` and read `agent-browser --session "$RUN" eval 'document.activeElement.textContent'` after each; they move between rows. Press `Enter` to focus `Event inspector`, then `Escape` to return to the timeline and `Escape` again to return to the session row. Press `/` to focus `Search events`. `Escape` does not leave the search field, so refocus the session row before the next bare key. Then `press "Shift+?"` (a bare `?` does nothing): the `Keyboard shortcuts` dialog lists seven bindings (`Move through the focused list`, `First or last item on this page`, `Move from sessions to timeline to inspector`, `Move back to the previous pane`, `Search events in the selected session`, `Toggle formatted and raw record`, `Show keyboard shortcuts`). Close it with `Escape`. <!-- unverified: `/` focusing Search sessions in stacked layout -->
- **Splitters (`traces-splitters`).** Run `agent-browser --session "$RUN" focus 'hr[aria-label="Resize the session list"]'` (a separator, default `260` at 1920 px), press `ArrowRight`, and read `agent-browser --session "$RUN" get attr 'hr[aria-label="Resize the session list"]' aria-valuenow`: `276` (+16). `Shift+ArrowRight` steps by 64 (`340`). Reload the page: `340` is kept. `agent-browser --session "$RUN" dblclick 'hr[aria-label="Resize the session list"]'` resets it to `260`. Press `Shift+ArrowLeft` five times: the value reads `0`, the session list hides, and a `Sessions` button appears; choosing it restores `260`. `Resize the timeline` (default `46`) steps 3 (`49`) and 10 with Shift (`59`); a double-click resets it to `46`.
- **Thread tab (`traces-thread-tab`, `traces-stacked`).** Create an idle fixture thread as in [GTD Sidebar](gtd-sidebar.md) preconditions (project `verify-traces` rooted at a disposable git repo under `$FX`, thread `Traces tab fixture` with `--send-at` a week out). Open it with `agent-browser --session "$RUN" open "$URL/threads/<thread-id>"` (bb redirects to `/projects/<pid>/threads/<id>`) and `wait --text "Traces tab fixture"`. Click `Show right panel (Ctrl + \)` by its snapshot ref (the backslash defeats `find --name`); the panel opens on a new tab whose buttons include `Task`, `Document`, `Review`, and `Traces`. Choose `Traces`. A `Traces` tab opens with the same toolbar and the fixture session; at 1920 px the panel's `main.tr-app` is about 790 px wide with no `data-layout`. Run `agent-browser --session "$RUN" set viewport 1200 1080 2`: `.tr-app` (about 430 px) gets `data-layout="stack"` and `data-pane="sessions"`, and only `Trace sessions` shows. Choosing the session row shows the timeline with `Back to sessions`; choosing an event shows the inspector with `Back to timeline`, which returns to `data-pane="timeline"`. Read state with `agent-browser --session "$RUN" eval 'document.querySelector(".tr-app").dataset.layout'` (`undefined` when wide). Restore `set viewport 1920 1080 2`.
- **Host picker (`traces-host-picker`).** Run `agent-browser --session "$RUN" find role combobox click --name "Trace host"`. Each host is an option; a single-host instance lists only its machine (selected). An offline one reads `<name> · Offline`. <!-- unverified: switching hosts and the offline label need a second host -->
- **Paging (`traces-pages`).** `Page 1` with `Previous page` disabled shows under both lists. To reach `Next page`, append 120 message lines to the fixture with a loop like the Live append command (distinct `uuid`s), then reopen the page. The timeline lists 100 rows (to `L100`), `Next page` under the timeline enables, and choosing it shows `Page 2` with the rest. The session list's own `Previous page`/`Next page` come first in the DOM and stay disabled, so click the timeline's buttons by ref.
- **RPC (`traces-rpc`).** Write `{"hostId":"<H>","limit":5}` to `$FX/rpc/sessions.json` and run `"$TB" plugin rpc call traces sessions --input-file "$FX/rpc/sessions.json" --json | jq '.items[] | {id, title, eventCount}'`. It lists `{"id":"<64-hex>","title":"verify-traces fixture","eventCount":10}`. `events` takes `{"hostId","sessionId"}` and returns `items`, `nextCursor`, `revision`, and `schemaVersion`; `event` and `raw` take `{"hostId","eventId"}`. `event` returns `body`, `bodyTruncated`, `event`, `message`, `related`, `schemaVersion`, and `sourceState`; `raw` returns `base64`, `offset`, `nextOffset`, `totalBytes`, `state`, `message`, and `schemaVersion`.
- **Thread scope (`traces-thread-scope`).** <!-- unverified: needs a real provider session file; the free fake ACP agent writes no Claude Code or Codex session --> Needs a thread that ran a Claude Code or Codex turn, which costs money, and whose provider wrote its session file on a host Traces reads. Open that thread's Traces tab: a `This BB thread only` checkbox shows checked, and the list shows only that thread's provider session. Unchecking it lists every session. An idle `--send-at` fixture thread has no provider session, so the checkbox does not render there.
- **Proof.** Capture each state with `agent-browser --session "$RUN" screenshot "$EV/traces-<state>.png"` and `agent-browser --session "$RUN" snapshot -i -c -s 'main.tr-app' > "$EV/traces-<state>.snapshot.txt"`.
- **Cleanup.**
  1. Leave every Traces page first (`open about:blank`). Remove the fixture source and confirm that its derived entries go: write `{"hostId":"<H>","roots":[]}` to `$FX/rpc/none.json`, run `"$TB" plugin rpc call traces configureSources --input-file "$FX/rpc/none.json" --json | jq -c '{sessions, roots}'`, which prints `{"sessions":0,"roots":[]}`, and check that `$FX/claude/verify-traces.jsonl` still exists. The empty root list is saved to the host's `sources.json`, and the host falls back to the real default folders only when that file is missing (`src/host/index.ts`), so a later enable stays empty.
  2. Delete any fixture project with `"$TB" project delete <project-id> --yes`.
  3. Remove the plugin from the test instance with `"$TB" plugin remove traces`, or disable it with `"$TB" plugin disable traces` to keep its index for a later run. `"$TB" plugin list --json | jq -c '.plugins[] | select(.id=="traces") | {enabled,status}'` prints nothing after remove, or `{"enabled":false,"status":"disabled"}` after disable.
  4. Remove `$FX`.

## Gotchas

- `bun scripts/test-instance.ts sync` disables every test plugin that live does not have enabled. Each sync turns Traces off again, so run `"$TB" plugin enable traces` after every sync.
- Never enable Traces on live for this check. Live has it disabled on purpose.
- The default sources are this user's real Claude Code and Codex folders. A first open before the fixture swap can index thousands of sessions, take minutes, and put private titles in screenshots. Run the `configureSources` step first. Indexes live in the test instance's plugin data, so they do not touch live's.
- Ctrl, Meta, and Alt chords never reach Traces' handlers, and keys typed into a field or an open dialog are ignored. Press `Escape` out of a search field before testing bare keys.
- Clicking a row auto-selects only when the container is 700px wide or more. In stacked layout nothing is selected until you choose a row.
- The splitters store sizes in this browser's `localStorage` (`traces:sessions`, `traces:timeline`). Reset them with a double-click before capturing layout evidence, or a pinned size from an earlier run carries over.
- Headless Chrome has `(hover: none)`, so splitter and toolbar tooltips need keyboard focus to open.
- `Search events` matches bounded summaries, tool names, and evidence labels, not every raw payload. A term only inside a long tool output may not match.
- The tool-result `success` and `error` badges come from the folded result. A call with no result has no badge.
- The `Sources` button stays disabled until the first `status` reply arrives.
- The thread tab follows the thread's environment host when that host is still listed, and otherwise the first online host.
- Over RPC, every method except `overview` needs `hostId`.
- `Escape` inside `Search events` keeps focus in the field; bare keys then type into it. Refocus a row first.
- `?` needs `press "Shift+?"` in agent-browser.
