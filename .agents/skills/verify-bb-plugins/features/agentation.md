# Agentation

Agentation puts a visual feedback toolbar over the whole bb app. A user turns on feedback mode, clicks any element, including one a plugin drew, and writes what should change. The annotation records the route, the owning plugin, and the selector, then waits in a shared staging area. Every thread composer shows the staged batch as a button. From there the user mentions, sends, or discards it. The `Agentation` nav panel holds the backlog: filter, resolve, dismiss, reopen, delete, reply, and stage again. Agents work the same records through nine `agentation_*` tools, and shells through `bb agentation`.

## Sub-features

- `agt-launcher-footer`: the sidebar-footer button `Toggle Agentation (⌃ ⇧ F)` (`⇧ ⌘ F` on macOS) turns feedback mode on and off.
- `agt-command`: the bb command `plugin:agentation/toggle-feedback-mode`, titled `Toggle Agentation`, runs from the command palette and from any key bound to it in Keyboard settings.
- `agt-chord`: the toolbar's own `Ctrl+Shift+F` / `Cmd+Shift+F` toggles feedback mode. `Escape` exits without closing the page underneath.
- `agt-vimium-chord`: with Vimium enabled, `Escape` then `a` within 1.5 s opens feedback mode. README claim; see Gotchas.
- `agt-annotate`: in feedback mode, clicking an element opens a popup (`What should change?`, `Add`, `Cancel`). `Add` saves the note and leaves a numbered marker.
- `agt-attribution`: an annotation on a plugin surface records that plugin's id and SDK surface. One on bb's shell records `pluginId: null`.
- `agt-toolbar-controls`: the expanded toolbar's `Feedback controls`: `Pause animations` (P), `Layout mode` (L), `Hide markers` (H), `Copy feedback` (C), `Clear all` (X), `Settings`, and `Exit`.
- `agt-toolbar-theme`: on first mount the toolbar takes the opposite of bb's theme, so light on dark bb. The user's later choice in its settings sticks.
- `agt-toolbar-visibility`: `bb agentation toolbar [on|off]` shows or hides the toolbar in every window. The footer button turns it back on.
- `agt-staging-action`: each thread and new-thread composer shows a `N annotation(s)` button listing the staged batch, with `Mention all`, `Send all`, `Discard all staged annotations`, and per-row `Mention annotation in composer`, `Send annotation to this thread`, and `Discard annotation`.
- `agt-mention`: mention pills insert annotations into the draft. An `Annotations` mention provider also offers them in the composer's mention search.
- `agt-discard`: discard moves staged feedback to the panel's `Dismissed` filter without asking first.
- `agt-send-thread`: sending assigns the batch to the thread and posts a `bb UI feedback from Agentation` message. This starts an agent turn.
- `agt-restage-turn-end`: an annotation the agent never acknowledged returns to staging when the turn ends. Everything assigned to a deleted thread also returns.
- `agt-panel`: the `Agentation` nav panel at `/plugins/agentation/annotations`, with an `N open` header count, `Filter annotations` (`Open`, `Resolved`, `Dismissed`, `All`), cards grouped by route, and the empty state `No annotations here yet.`
- `agt-panel-actions`: card buttons `Resolve`, `Dismiss`, `Reopen`, `Delete`, `Open assigned thread`, `Open source thread`, `Stage again`, and the `Reply` form.
- `agt-cli`: `bb agentation pending|staged|send|restage|sessions|show|acknowledge|resolve|dismiss|reply|toolbar`.
- `agt-tools`: the agent tools `agentation_list_sessions`, `agentation_get_session`, `agentation_get_pending`, `agentation_get_all_pending`, `agentation_acknowledge`, `agentation_resolve`, `agentation_dismiss`, `agentation_reply`, and `agentation_watch_annotations`.
- `agt-instructions`: the thread instruction snippet `The human has N unresolved Agentation annotation(s) …` while annotations are pending, and the bundled `agentation` skill.
- `agt-live-sync`: an agent or CLI resolve removes the marker from every open bb window within about a second.
- `agt-settings`: **Settings → Plugins → Agentation** shows `When sending to an active thread` (`Default`, `Queue`, `Steer`), `Days to keep resolved annotations` (default `7`), `Run the shared Agentation server on each machine` (default off), and the `How this works` section.
- `agt-local-server`: with that last setting on, each connected machine runs `agentation-mcp` on `localhost:4747`.
- `agt-prune`: a nightly job at 04:17 deletes resolved and dismissed annotations older than the retention setting.
- `agt-rpc` exposes the discoverable RPC methods the CLI and tools use, plus HTTP `/health` (counts) and `/events` (the toolbar's event stream): `curl -s "$URL/api/v1/plugins/agentation/http/health"` returns `{"ok":true,"pluginId":"agentation",…,"counts":{…}}`.
- `agt-mention-assign` assigns the annotations whose pills a sent message carries to that thread. Needs a turn; use the fake agent. <!-- unverified: added from a source audit, not driven -->
- `agt-dispatch-recovery` returns annotations a server restart interrupted mid-delivery to staging. <!-- unverified: added from a source audit, not driven -->

## How to get to it (user POV)

- Choose `Toggle Agentation (⌃ ⇧ F)` in the sidebar footer, press `Ctrl+Shift+F` (`Cmd+Shift+F` on macOS) anywhere, or run `Toggle Agentation` from the command palette (`Mod+K`).
- A key bound in **Settings → Keyboard** also runs the command. The test instance mirrors `Mod+Shift+A` with no platform, shown as `Ctrl + Shift + A` on Linux.
- With Vimium on, press `Escape` and then `a` (broken on the test instance; see Gotchas).
- In feedback mode, click any element, type a note, and press `Add` or `Enter`. Press `Escape` or the toolbar's `Exit` button to leave.
- In any thread's composer, or Home's new-thread composer, choose the `N annotation(s)` button. A mouse hover only previews the list, and on a compact viewport the list opens as a drawer.
- Open the `Agentation` entry in the sidebar navigation, or go to `/plugins/agentation/annotations`.
- Open **Settings → Plugins → Agentation** at `/settings/plugins/agentation`.
- From a shell, run `bb agentation …`. Agents in a thread get the `agentation_*` tools with no setup.

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin agentation`. For `agt-vimium-chord`, it must also pass with `--plugin vimium`.
- The browser session was opened per SKILL.md, in Dark with bb Monokai.
- Free and paid steps:
  - Annotate, staging, mention, discard, the panel, the CLI, and settings cost nothing.
  - Every path to the `assigned` state calls a thread send and starts one agent turn. That covers a row send, `Send all`, `bb agentation send`, `Send all` in a new-thread composer, and the panel's `Reply`. Send only to a thread on the local fake agent, as the agent-turn tier below describes; any other provider costs money.
- The toolbar renders inside the open shadow root of the `<agentation-toolbar>` element. Its controls, popup, and markers do not appear in `snapshot` or `find role`. Read them with `eval` on `.shadowRoot`; `keyboard type` reaches the autofocused note field.
- Join the UI and the CLI on a unique comment such as `verify-<RUN>-one`, never on the element name. Record the annotation id that `"$TB" agentation staged --json` prints for it.
- Make one idle fixture thread for the composer steps, and record its id:

  ```bash
  FX="$BB_THREAD_STORAGE/verify/$RUN-fixtures"; mkdir -p "$FX"
  git init -q "$FX/verify-agt" && git -C "$FX/verify-agt" commit -q --allow-empty -m init
  "$TB" project create --name verify-agt --root "$FX/verify-agt" --json | jq -r '.project.id // .id'
  AT=$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)   # macOS: date -u -v+7d +%Y-%m-%dT%H:%M:%SZ
  "$TB" thread spawn --project <project-id> --title "Agentation fixture" --prompt hello --send-at "$AT" --json | jq -r '.thread.id // .id'
  ```

### Free loop (no agent turn)

- **Baseline.** Run `"$TB" agentation toolbar`, which prints `on`. If it prints `off`, record that and run `"$TB" agentation toolbar on`. Run `"$TB" agentation pending --json | jq length` and `"$TB" agentation staged --json | jq length` and record both counts. Live state is not mirrored, so both should be `0` unless another run on the same instance left some; act only on your own ids.
- **Settings.** Run `agent-browser --session "$RUN" open "$URL/settings/plugins/agentation"` and `agent-browser --session "$RUN" wait --text "When sending to an active thread"`.
  - The page shows `Default` for that setting with the hint `Default follows bb's “Steer running threads on Enter” setting. Queue and Steer override it. Idle threads always start immediately.`, then `Days to keep resolved annotations` and `Run the shared Agentation server on each machine`, whose description begins `Keeps agentation-mcp serving localhost:4747 on every connected machine`. The `How this works` section was not checked. <!-- unverified: How this works section -->
  - Run `"$TB" plugin config agentation --json | jq -c '.values | {deliveryMode, retentionDays, localServer}'`. It prints `{"deliveryMode":"Default","retentionDays":"7","localServer":false}` on the test instance.
  - Change nothing here.
- **Theme seed (`agt-toolbar-theme`).** Return Home with `agent-browser --session "$RUN" open "$URL"` and `agent-browser --session "$RUN" wait --text "New thread"`.
  - `agent-browser --session "$RUN" eval 'localStorage.getItem("feedback-toolbar-theme")'` prints `"light"` on dark bb.
  - `agent-browser --session "$RUN" eval 'document.querySelector("agentation-toolbar")?.shadowRoot?.querySelector("[data-agentation-theme]")?.getAttribute("data-agentation-theme")'` prints `"light"`. The toolbar's settings offer `Switch to dark mode`; the later choice sticking was not driven. <!-- unverified: later theme choice persists -->
- **Toolbar probe.** Define `TBD='getComputedStyle(document.querySelector("agentation-toolbar").shadowRoot.querySelector("[data-agentation-toolbar]")).display'`. It prints `"none"` with feedback mode off and `"block"` with it on.
- **Launcher (`agt-launcher-footer`).** Press `Escape` first so that no key reaches the composer.
  - Run `agent-browser --session "$RUN" find role button click --name "Toggle Agentation"`. The footer button's full name is `Toggle Agentation (⌃ ⇧ F)`.
  - `agent-browser --session "$RUN" eval "$TBD"` prints `"block"`, and `agent-browser --session "$RUN" eval '!!document.querySelector("agentation-toolbar").shadowRoot.querySelector("button[aria-label=Exit]")'` prints `true`.
  - Choose the footer button again. The probe prints `"none"`.
- **Chord and Escape (`agt-chord`).** Run `agent-browser --session "$RUN" press "Control+Shift+f"`. The probe prints `"block"`. Run `agent-browser --session "$RUN" press Escape`; it prints `"none"`, and the URL is unchanged.
- **Command palette (`agt-command`).**
  - Run `agent-browser --session "$RUN" eval 'document.activeElement.blur()'`, `agent-browser --session "$RUN" press "Control+k"`, `agent-browser --session "$RUN" wait '[role="dialog"] input[aria-label="Search commands"]' --timeout 3000`, `agent-browser --session "$RUN" keyboard type "Toggle Agentation"`, and `agent-browser --session "$RUN" press Enter`. The one option reads `Toggle Agentation` `Agentation` `Ctrl + Shift + A`.
  - The probe prints `"block"`. Press `Escape` to leave feedback mode.
- **Bound key (`agt-command`).** Run `"$TB" settings keyboard list --json | jq -c '[.overrides[] | select(.command | startswith("plugin:agentation/"))]'`. The test instance has `toggle-feedback-mode` on `{"key":"a","mod":true,"shift":true}` with no platform field, shown as `Ctrl + Shift + A` under Settings → Keyboard.
  - On Home, after the bindings register, run `eval 'document.activeElement.blur()'` and `agent-browser --session "$RUN" press "Control+Shift+a"`. The probe prints `"block"`; `Escape` leaves.
- **Annotate (`agt-annotate`).** Enter feedback mode with `Control+Shift+f`, then click a stable shell element, such as the footer's Settings link: `agent-browser --session "$RUN" find role link click --name "Settings"`. Feedback mode takes the click; the URL stays `/`.
  - A popup with placeholder `What should change?` opens and takes focus: `agent-browser --session "$RUN" eval '(s => [!!s.querySelector("[data-annotation-popup] textarea"), s.activeElement?.placeholder])(document.querySelector("agentation-toolbar").shadowRoot)'` prints `[true, "What should change?"]`.
  - Type the note into the focused field: `agent-browser --session "$RUN" keyboard type "verify-$RUN-one"`. Then run `agent-browser --session "$RUN" press Enter`, since `Enter` submits like `Add`.
  - A marker named `Edit annotation 1: <element>` appears inside the shadow root while feedback mode is on: `agent-browser --session "$RUN" eval 'document.querySelector("agentation-toolbar").shadowRoot.querySelectorAll("[data-annotation-marker]").length'` prints `1`. With feedback mode off it prints `0`; markers render only in feedback mode.
  - **Second view.** Run `"$TB" agentation staged --json | jq -r --arg c "verify-$RUN-one" '.[] | select(.comment==$c) | .id'` and record the id as `<a1>` (a millisecond timestamp such as `1795572119027`).
  - `"$TB" agentation pending` lists `<a1>  pending      bb-shell …`, and `"$TB" agentation show <a1>` prints the full record: `**Where:** bb app shell · route `/` (home)`, `**Selector:** …#sidebar-footer-settings > svg`, `**Status:** pending`, `**Feedback:** verify-…-one`.
- **Plugin attribution (`agt-attribution`).**
  - Open `"$URL/plugins/agentation/annotations"` and run `agent-browser --session "$RUN" wait '[role=radiogroup][aria-label="Filter annotations"]' --timeout 15000`. `Filter annotations` is an accessible name, not visible text, so `wait --text` misses it.
  - In feedback mode, click the `Open` filter item (`find role radio click --name "Open"`), then add the note `verify-$RUN-two` as above.
  - `"$TB" agentation pending --plugin agentation --json | jq -r --arg c "verify-$RUN-two" '.[] | select(.comment==$c) | "\(.id) \(.bb.pluginId) \(.bb.surface)"'` prints `<a2> agentation navPanel`. Record `<a2>`.
  - `"$TB" agentation sessions` lists `/` and `/plugins/agentation/annotations` with `pending=1 total=1`, among a session for every route any browser opened.
- **Toolbar controls (`agt-toolbar-controls`).** In feedback mode, press `h` outside any text field. Markers hide, and the control's name changes to `Show markers`. Press `h` again to restore them. `p` toggles `Pause animations` / `Resume animations` and `l` toggles `Layout mode` / `Exit layout mode`. Read the names with `agent-browser --session "$RUN" eval '[...document.querySelector("agentation-toolbar").shadowRoot.querySelectorAll("[aria-label]")].map(e=>e.getAttribute("aria-label"))'`: `Feedback controls`, `Pause animations`, `Layout mode`, `Hide markers`, `Copy feedback`, `Send Annotations`, `Clear all`, `Settings`, `Exit`, then the settings panel's controls. Do not press `X` (`Clear all`) or `Send Annotations` on the same instance; `C` copies to a clipboard headless Chrome cannot read. <!-- unverified: C, X, Send Annotations -->
- **Composer staging list (`agt-staging-action`).**
  - Open the fixture thread from its sidebar row (`agent-browser --session "$RUN" click '[data-gtd-row="<thread-id>"] a[data-sidebar-thread-id]'`); its URL is `/projects/<project-id>/threads/<thread-id>`. Run `agent-browser --session "$RUN" wait '[data-agentation-staging-action]' --timeout 15000`.
  - `agent-browser --session "$RUN" get attr '[data-agentation-staging-action]' aria-label` prints `2 annotations`.
  - Choose it: `agent-browser --session "$RUN" click '[data-agentation-staging-action]'`. The list shows `Mention all`, `Send all`, and `Discard all staged annotations`, and two rows, each with `Mention annotation in composer`, `Send annotation to this thread`, and `Discard annotation`. The row location text was not read. <!-- unverified: home / agentation panel location labels -->
- **Mention (`agt-mention`).**
  - In the list, choose `agent-browser --session "$RUN" find role button click --name "Mention all"`. Focus returns to the composer. With T3 Composer, which the instance mirrors, the draft shows a `2 annotations` chip with `Remove 2 annotations` instead of pills, and the staging button hides. With bb's composer the draft holds two pills labelled `[<location>] <element> → verify-…`. <!-- unverified: pill labels with bb's composer -->
  - `Remove 2 annotations` clears the chip; both annotations stay staged and the staging button returns. Clear the draft before the next step, and do not send it on a paid provider.
  - The mention provider's search under `@` is labelled `Annotations`. <!-- unverified: bb's mention UI path -->
- **Discard one (`agt-discard`).**
  - Reopen the list, then run `agent-browser --session "$RUN" find role button click --name "Discard annotation"`. `find` takes the first match, which is row 1 (`<a1>` here).
  - A `Discarded 1 annotation.` toast appears: `agent-browser --session "$RUN" eval '[...document.querySelectorAll("[data-sonner-toast]")].map(t=>t.textContent)'`.
  - The button's label becomes `1 annotation`. `"$TB" agentation staged --json | jq length` drops by one, and `"$TB" agentation show <a1>` shows `**Status:** dismissed`.
- **Panel (`agt-panel`).**
  - Open `"$URL/plugins/agentation/annotations"` and wait for the filter radiogroup as above. The filter radios are `Open` (checked), `Resolved`, `Dismissed`, and `All`.
  - Under `Open`, one card per open annotation appears under a route heading with `N annotation(s)`. Each card shows the element, the status and `staged`, `bb shell` or `plugin: agentation` with the surface, the comment, `Selector:`, `React:`, and buttons `Resolve`, `Dismiss`, `Delete`, and `Reply`.
  - The panel header shows `N open`, which counts pending only.
  - Choose `Dismissed`: `agent-browser --session "$RUN" find role radio click --name "Dismissed"`. The discarded card appears with `Reopen`, `Delete`, and `Reply`.
- **Reopen re-stages (`agt-panel-actions`).** On the dismissed card, choose `Reopen`. The `Dismissed` view reads `No annotations here yet.`, and `"$TB" agentation staged --json` lists it again with status `pending`.
- **CLI lifecycle (`agt-cli`).** The CLI is the free twin of the agent tools; it proves `agt-cli`, not `agt-tools`.
  - Run `"$TB" agentation acknowledge <a1> verify-ack`, which prints `acknowledged <a1>`. The panel card should read `acknowledged` and the header's `N open` drop by one. <!-- unverified: panel not read between acknowledge and resolve -->
  - Run `"$TB" agentation reply <a1> verify-question`, which prints `Replied on <a1>.`. The card shows a line `agent verify-question`.
  - Run `"$TB" agentation resolve <a1> verify-fixed`, which prints `resolved <a1>`. The card leaves `Open`, and under `Resolved` it shows `resolved`, `agent verify-question`, `Outcome: verify-fixed`, and `Reopen`, `Delete`, `Reply`.
- **Live sync (`agt-live-sync`).** Markers render only in feedback mode, so open it on the annotation's route with no note popup open: on `/plugins/agentation/annotations`, `Control+Shift+f`, and the marker count for `<a2>` is `1`. Run `"$TB" agentation resolve <a2> verify-fixed-two`, then `agent-browser --session "$RUN" wait --fn 'document.querySelector("agentation-toolbar").shadowRoot.querySelectorAll("[data-annotation-marker]").length === 0' --timeout 5000`. It passed within 0.1 seconds of the command returning. Press `Escape`.
- **CLI errors.** These fail with exit 1 and change nothing:
  - `"$TB" agentation dismiss <a2>`: `dismiss needs a reason (usage: bb agentation dismiss <annotationId> <reason…>)`.
  - `"$TB" agentation show nope`: `No annotation nope. (Run \`bb agentation pending\` for the open annotation ids.)`.
  - `"$TB" agentation toolbar maybe`: `toolbar state must be on or off, got "maybe" (usage: bb agentation toolbar [on|off])`.
  - `"$TB" agentation restage <a2>`: `Annotation <a2> is not an assigned open annotation. (Run \`bb agentation pending\` to see each annotation's state.)`.
  - `"$TB" agentation send thr_doesnotexist <a2>`: `bb agentation failed: HTTP 404: Thread not found`, and `<a2>` stays in `"$TB" agentation staged`.
- **Toolbar visibility (`agt-toolbar-visibility`).**
  - Run `"$TB" agentation toolbar off`, which prints `toolbar off`. `agent-browser --session "$RUN" wait --fn '!document.querySelector("agentation-toolbar")' --timeout 10000` passes; the footer button stays.
  - Choose the footer `Toggle Agentation` button. `"$TB" agentation toolbar` prints `on`, and the toolbar opens in feedback mode (probe `"block"`). Press `Escape`.
- **RPC surface.** `"$TB" plugin rpc list agentation` lists `clearSessionAnnotations`, `discardStagedAnnotations`, `getConfig`, `listAnnotations`, `listSessions`, `listStagedAnnotations`, `mutateAnnotation`, `openSession`, `pullSession`, `pushAnnotations`, `replyToAnnotation`, `restageAnnotation`, `sendStagedAnnotations`, and `setToolbarEnabled`, each with a description. `curl -s "$URL/api/v1/plugins/agentation/http/health" | jq -c .counts` answers from the local origin without auth and prints `{"pending":…,"acknowledged":…,"resolved":…,"dismissed":…,"total":…}`.
- **Instructions (`agt-instructions`).** `"$TB" skill list --json | jq -r '.. | .name? // empty' | grep -x agentation` prints `agentation`. The pending-count snippet is checked in the fake-agent tier below.
- **Proof.** Capture `$EV/agt-toolbar-open.png`, `$EV/agt-popup.png`, `$EV/agt-marker.png`, `$EV/agt-staging-list.png`, `$EV/agt-panel-open.png`, and `$EV/agt-panel-resolved.png`. Save `"$TB" agentation pending --json > "$EV/agt-pending.json"` before and after the lifecycle steps.

### Agent-turn tier (local fake agent)

Precondition: the local fake agent is registered (SKILL.md, Free agent turns) and `$EV/reply.md` holds `{{ECHO}}`. Send only to a thread on that provider: `"$TB" thread spawn --project <project-id> --provider acp-verify-fake --title "Agentation fake" --prompt hello --json`, then `"$TB" thread wait <fake-id> --timeout 60`. The scheduled fixture thread is on a paid provider; never send to it. The fake agent cannot call tools, so it never acknowledges.

- **Instruction snippet (`agt-instructions`).** With one annotation pending, the fake thread's first prompt in `$EV/fake-agent.jsonl` holds `The human has 1 unresolved Agentation annotation on the bb interface. Before acting on a request about the bb UI, call agentation_get_all_pending only when …`, and the prompt's skill list includes `agentation: Act on bb UI feedback from Agentation annotations …`.
- **Send (`agt-send-thread`).** Run `"$TB" agentation send <fake-id> <a2>`, which prints `Sent 1 annotation to this thread.`, or open the fake thread from its row, choose the staging button, and `Send annotation to this thread`: the `Sent 1 annotation to this thread.` toast appears. `"$TB" thread log <fake-id>` shows a message headed `## bb UI feedback from Agentation` that ends `…Resolve each item with the \`agentation_resolve\` tool once it is fixed, or use \`agentation_reply\` if you need a decision from me.`
- **Turn-end re-stage (`agt-restage-turn-end`).** Once the fake turn ends (`thread wait`), `"$TB" agentation staged --json` lists `<a2>` again with status `pending`, because the agent never acknowledged it. An annotation acknowledged through the CLI before a UI send was reset to `pending` and re-staged the same way.
- **Assigned states (`agt-panel-actions`).** The panel's `assigned: <thread-id>`, `Open assigned thread`, `Reply` to the assigned thread (`Agentation follow-up`), `Stage again` and `"$TB" agentation restage <a3>` (prints `staged <a3>`), and deleting a thread to re-stage its batch all need an annotation that stays assigned, which needs an agent that calls `agentation_acknowledge` during its turn. The fake agent cannot, and a CLI acknowledge raced against the send did not win. <!-- unverified: needs a model that calls agentation_acknowledge -->
- **Tools (`agt-tools`).** The fake agent's `session/new` carries the `bb-bridge` MCP server, but it calls no tools. The nine `agentation_*` tools stay unverified without a real model. <!-- unverified: needs a model -->
- **Delivery mode (`agt-settings`).** Setting `When sending to an active thread` to `Queue` or `Steer` matters only while a turn runs, and the fake turn ends at once. <!-- unverified: needs a running turn -->

## Gotchas

- **No CLI delete.** `"$TB" project delete` removes fixture threads, not annotations. Clean up in the panel: choose `All`, then `Delete` on each of your own cards; it deletes at once with no confirmation. Do not use `Clear all` on the same instance. Confirm with `"$TB" agentation pending --json | jq length` and `"$TB" agentation staged --json | jq length` back at the baseline. Then restore `toolbar on` and any setting you changed.
- **Vimium's `Escape`, `a` path is broken.** Vimium clicks `button[aria-label="Toggle Agentation feedback mode"]`, but the footer button's name is `Toggle Agentation (⌃ ⇧ F)`. On the test instance `Escape`, `a` from the composer left the probe at `"none"` in two runs with a healthy Vimium, while the footer button worked. Report it as a product gap.
- **Vimium also claims `Meta+Shift+f`** for its hints. Drive Agentation's chord as `Control+Shift+f`, which Vimium ignores.
- **The README names commands that do not exist.** It says `Toggle Agentation feedback mode` and `Toggle Agentation toolbar`, but the command and the footer button are both titled `Toggle Agentation`. Search the palette and the Keyboard settings for `Toggle Agentation`.
- **The shadow root.** Toolbar controls, the note popup, and the markers live in `<agentation-toolbar>`'s shadow root, and markers exist only while feedback mode is on. Typing the note relies on the popup's autofocus, so check `shadowRoot.activeElement` before `Enter`.
- **Feedback mode intercepts clicks.** While it is on, every page click is a target, and the footer button is the exception. Leave with `Escape` before driving other UI.
- **A busy popup defers refresh.** While the note popup holds text or the caret, agent decisions and marker removal wait. Finish or cancel the note before asserting `agt-live-sync`.
- **The header count differs from the Open filter.** `N open` counts pending annotations; the `Open` filter also lists acknowledged ones. Expect them to differ after an acknowledge.
- **The staging button hides at zero.** It renders only while something is staged, so an absent button with an empty batch is not a gap. On a compact viewport the list opens as a drawer, and its controls are 28px, under the 44px touch-target rule.
- **New-thread `Send all` costs a turn.** It submits the Home composer with the pills and creates a thread. It is not free.
- **The local server escapes the test instance.** `Run the shared Agentation server on each machine` starts `agentation-mcp` on `localhost:4747` with its store in `~/.agentation`. Both are machine-wide, and `agentation-mcp` is on this machine's PATH. Leave the setting off unless the parent decides the run may touch port 4747. If it is turned on, check the port first, and turn the setting off afterwards.
- **The prune job runs at 04:17 only.** There is no manual trigger for it. Report it as unverified, or check the retention value only.
- **Some state stays per browser.** Live's theme choice, notes typed but not yet sent, and the per-route sync ledger (`bb-agentation-synced-<route>`) live in the browser's localStorage. A fresh agent-browser profile starts with none of them.
- **Composer drafts persist.** Clear any annotation pills from a draft before the run ends, or a later send assigns them.
- **Sessions pile up.** Every route any browser opens gets a session, so `"$TB" agentation sessions` lists far more than your annotated pages. Grep it for your routes.
- **Fake turns end at once.** An annotation sent to the fake agent returns to staging as soon as its turn ends, so any assigned-state step must run while a real turn holds it.
