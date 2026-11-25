# Kitchen Sink: RPIV task list

Kitchen Sink shows a collapsible task list above the thread composer, queued-message composers, and side-chat composers when the thread's agent has kept a to-do list with the Pi `rpiv-todo` extension's `todo` tool. Its header shows completion counts and the current task, the list puts the in-progress task first, and a setting chooses whether it opens expanded. Threads with no to-do calls show nothing.

## Sub-features

- `ks-todo-banner` shows the task list card above the composer, with header `<done>/<total> complete` and, while a task runs, `· <current task>`.
- `ks-todo-order` sorts in-progress tasks first, then pending, then completed, each row prefixed `#<id>`.
- `ks-todo-toggle` collapses and expands the list from its header button.
- `ks-todo-expand-setting` sets whether the list opens expanded (**Expand RPIV task list when opening a thread**, default on).
- `ks-todo-live` refreshes while the agent runs and on reconnect, and clears after a context clear.
- `ks-todo-states` shows `Loading task history…` for long histories and `Could not refresh tasks` with **Retry** after a failed read.
- `ks-todo-empty` renders nothing for a thread with no successful `todo` calls.
- `ks-todo-rpc` returns a thread's task snapshot through the `getRpivTodos` RPC method.

## How to get to it (user POV)

- Open a thread whose agent ran Pi with `@juicesharp/rpiv-todo` installed and called `todo`. The card sits above the composer.
- Open a queued message's composer or a side chat in that thread; the same card shows there.
- Choose the card's header to collapse or expand it. Its controls keep focus in the composer.
- Open **Settings → Plugins → Kitchen Sink** for **Expand RPIV task list when opening a thread**.

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin kitchen-sink`.
- A fixture project and an idle thread exist, as in [thread details](kitchen-sink-thread-details.md). That covers `ks-todo-empty`, `ks-todo-rpc`, and the setting.
- The banner itself needs a thread whose stored events include a completed `todo` tool call. That takes a Pi agent turn with `@juicesharp/rpiv-todo` installed on the test instance's Pi, which costs money and is not mirrored from live. Without it, `ks-todo-banner`, `ks-todo-order`, `ks-todo-toggle`, `ks-todo-live`, and `ks-todo-states` are unreachable; report them with this prerequisite. The free local fake agent (SKILL.md **Free agent turns**) cannot stand in: it answers with text only and emits no tool calls. Any long-lived test thread that already holds such calls is on live only: view it read-only and label the evidence as from live.

- **Empty thread.** Open the fixture thread with `agent-browser --session "$RUN" open "$URL/projects/<ks-project-id>/threads/<ks-thread-id>"` and wait for the composer. Run `agent-browser --session "$RUN" eval '!!document.querySelector(".rpiv-todo-card")'`, which returns `false`, and `agent-browser --session "$RUN" snapshot -i -c | grep -c "To-do list"`, which prints `0`.
- **RPC read.** Run:

  ```bash
  echo '{"threadId":"<ks-thread-id>"}' > "$EV/ks-todo.json"
  "$TB" plugin rpc call kitchen-sink getRpivTodos --input-file "$EV/ks-todo.json" --json
  ```

  It prints `{"items": [], "truncated": false}`. The method is not listed by `plugin rpc list` (only `projectScripts` and `saveProjectScript` are discoverable) and `plugin rpc inspect kitchen-sink getRpivTodos --json` prints `[]`, but `call` still reaches it.

- **Setting.** Record the mirrored value with `"$TB" plugin config kitchen-sink --json | jq .values.rpivTodoExpandOnEnter`. Open `agent-browser --session "$RUN" open "$URL/settings/plugins/kitchen-sink"` and `agent-browser --session "$RUN" wait --text "Expand RPIV task list when opening a thread"`, then run `agent-browser --session "$RUN" find role switch click --name "Expand RPIV task list when opening a thread"`. The page is headed `Kitchen Sink` with a `Configuration` section holding this one switch (`checked=true` by default; the page's other switch is `Disable kitchen-sink`, which must not be touched). After the click, `"$TB" plugin config kitchen-sink --json | jq -c .values` prints `{"rpivTodoExpandOnEnter":false}`. Reopen the page; the switch reports `checked=false`. Restore it with the switch or `"$TB" plugin config kitchen-sink set rpivTodoExpandOnEnter <recorded>`.
- **Banner (needs the Pi turn).** Open the thread with to-do calls and run `agent-browser --session "$RUN" snapshot -i -c`. A button named `To-do list: <done> of <total> items complete` (or `…, now <current task>` while one runs) appears above the composer, with `expanded=true` when the setting is on. The visible header reads `<done>/<total> complete`, and the list rows read `#<id> <task>`, in-progress first. <!-- unverified: needs a Pi thread with rpiv-todo calls -->
- **Toggle.** Run `agent-browser --session "$RUN" find role button click --name "To-do list"`. The button reports `expanded=false` and the rows leave the snapshot. Choose it again to expand. Confirm the composer kept focus with `agent-browser --session "$RUN" eval 'document.activeElement?.closest("[contenteditable], textarea") !== null'`. <!-- unverified: needs the Pi thread -->
- **Collapsed start.** With the setting off, open the thread again: the button starts at `expanded=false`. A toggle made before the setting loads wins over it. <!-- unverified: needs the Pi thread -->
- **Live refresh.** While the agent runs, the header count changes without a reload, polling about every 1.2 seconds. <!-- unverified: needs a running Pi turn -->
- **RPC twin.** With the Pi thread, the `getRpivTodos` read lists the same items and statuses the card shows. <!-- unverified: needs the Pi thread -->
- **Proof.** Capture `agent-browser --session "$RUN" screenshot "$EV/ks-todo-<state>.png"` for empty, expanded, and collapsed states.
- **Cleanup.** Restore `rpivTodoExpandOnEnter`, then delete fixtures as the thread-details file does.

## Gotchas

- The test instance does not install Pi extensions from live. A Pi thread there without `rpiv-todo` makes no `todo` calls, so an absent banner proves nothing about rendering.
- Failed, errored, or `Error:`-prefixed `todo` calls are skipped, and a completed context clear empties the list. A shorter list than the transcript suggests may be correct.
- The card hides while the connection is down and it has no saved tasks. Saved tasks stay visible offline.
- Polling pauses while the tab is hidden. Keep the test tab foreground when checking live refresh.
- Transcript tool cards keep bb's own rendering; Kitchen Sink draws only the composer card.
- `find role button --name …` with no action is rejected (`Unknown action '--name' for find`). Count matches with `snapshot -i -c | grep -c` instead.
