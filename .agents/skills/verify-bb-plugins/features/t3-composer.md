# T3 Composer

T3 Composer replaces bb's prompt box on Home and in threads with a ChatGPT-style card: a `+` menu, a model pill with a searchable picker and favorites, an effort and speed pill, a permission-mode pill, attachment tiles and context chips above the text, a Save draft icon, and a round send button. bb's project, machine, and branch row sits as a tray attached above the card. `#` keywords set pickers from the text, and inline prompts from the `/` menu send a skill's body with the message.

## Sub-features

- `t3-renderer` makes T3 Composer bb's composer on Home, in threads, and in queued-message and sent-message editors. It is chosen under **Settings → Appearance → Composer**.
- `t3-tray` attaches bb's project, machine, and branch row (`[data-new-thread-footer]` on Home, `[data-follow-up-composer-footer]` in a thread) as a tray above the card, and restyles bb's Project and Environment menus.
- `t3-tray-keeper` keeps a thread composer expanded so its tray stays rendered.
- `t3-branch-style` restyles bb's branch picker popover and phone sheet to match the machine menu, and marks the chosen row.
- `t3-plus-menu` opens a `Prompt actions` menu with `Attach files`, `Skills`, `Plan`, `Goal` (each when bb offers it), and other plugins' plus-menu items.
- `t3-model-picker` opens a model popover with `Search models...`, a `Favorites` tab, a tab per provider, `⌘1`–`⌘9` (Ctrl on Linux) jump keys, and arrow, Enter, and Shift+Tab or Left navigation.
- `t3-favorites` stars and unstars models with Ctrl+D or the star button. Stars are stored per bb server and lead the `Favorites` tab.
- `t3-effort` opens the effort pill (`Effort: <level>`) to an `Effort` slider, with arrow, Home, and End keys and a `Reset effort to <default>` button.
- `t3-speed` steps a `Speed: <current>. Switch to <next>` toggle through Normal, Fast, and Ultrafast where the model offers tiers. A bolt marks the pill.
- `t3-agent-switch` shows Codex's Daybreak switch under the slider, driving bb's hidden picker. It shows `Set by this model` when the model fixes it.
- `t3-model-shortcuts` handles bb's `modelPicker.cycleModel`, `cycleProvider`, and `cycleReasoning` keybindings (forward and backward) inside the composer.
- `t3-permission` opens a `Permission mode` menu titled `How should <provider> actions be approved?` with `Accept Edits`, `Approve for me`, and `Full Access`. A mode above the machine limit is disabled with `Above the selected machine's permission limit. Change it in Settings → Machines.`
- `t3-permission-kept` keeps a mode picked on a thread but not yet sent across thread switches in the same page. This is bb workaround `t3-composer/thread-permission-reset`.
- `t3-keywords` handles `#full`, `#auto` or `#approve`, `#edits`, a reasoning level such as `#high`, or a starred model's word, followed by a space. It sets that picker and removes the keyword. An ambiguous model shows `#<word> matches more than one starred model.`
- `t3-slash-menu` lists commands and skills under `/`. Enter or a click on a bb built-in command inserts it and sends at once. Tab inserts without sending.
- `t3-mention-menu` lists `@` mentions, including an `Attachments` group for attached non-image files, with `Searching mentions…`, `Failed to load suggestions`, and `Type to search mentions` states.
- `t3-inline-prompts` makes a user-tier skill whose SKILL.md frontmatter has `inline: true` insert, when picked from `/`, a Zap pill whose body is sent with the message.
- `t3-attachments` adds attachments through the menu, a file drop, or a paste. They appear as 120px image tiles or 160px file tiles with `Remove <name>` and `Uploading <name>` states. An image opens `Attached media preview`.
- `t3-context-chips` shows annotation and comment mentions as counted chips (`N annotations`, `N comments`) above the text, hides their pills, and offers `Remove <label>`.
- `t3-thread-link-paste` turns a pasted bb thread link into a thread mention pill.
- `t3-save-draft` saves the message from the `Save draft` icon as a queued message held with reason `Draft`, sent only by hand. The icon needs bb's Drafts plugin.
- `t3-keys` covers the editor keys: Enter sends (hardware keyboard, fine pointer), Shift+Enter adds a newline or leaves a blockquote, Ctrl/⌘+Enter runs bb's alternate send action, Escape closes a menu or blurs the editor, and Up/Down at the end of an empty draft walks prompt history.
- `t3-submit` shows a round send button whose name is bb's submit title (default `Submit (Enter)`), a disabled reason in a tooltip, `Uploading attachments...` while uploading, and `Stop run` while a turn runs.
- `t3-voice` provides `Start voice input`, the recording bar, and failed-recording retry. On touch with an empty draft, voice becomes the primary button.
- `t3-handoff` handles a leading `/handoff` in a thread composer, typed or picked, as bb's handoff command.
- `t3-compact` covers phones (max-width 767px). `+` becomes a direct `Attach files` button, the model picker opens a `Models` sheet (with `Agents`), Project and Machine open sheets (`Projects` with `Search projects`, `Don't work in a project`, `New project`, and `Machines`), and the thread tray label moves under the title while the context ring moves into the card.
- `t3-child-threads-banner` redraws bb's child-threads banner, the card above the composer of a thread that has child threads, with the composer card's hairline outline. Needs a thread with a child thread (a fake-turn parent and child). <!-- unverified: added from a source audit, not driven -->

## How to get to it (user POV)

- **Settings → Appearance → Composer** lists `T3 Composer`. With `Automatic`, bb may already pick it. Choose bb's built-in `Composer` there to switch back. The test instance mirrors T3 Composer as active; switching is a global Appearance choice and was not driven. <!-- unverified: Appearance page not driven -->
- Open Home (`New thread`) or any thread. The card is the prompt box at the bottom.
- Press `+` for prompt actions, the model pill for models, the effort pill for effort and speed, and the permission pill for approval mode. The tray above the card holds bb's Project, Machine, and Branch controls.
- Type `/` or `@` in the editor for the command and mention menus, and `#keyword ` for setting keywords.
- Drag, drop, or paste files onto the card to attach them.
- On a phone-width window, the same controls open bottom sheets.

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin t3-composer`. `t3-save-draft` also needs bb's Drafts built-in: `"$TB" plugin list --json | jq -c '.plugins[] | select(.id=="drafts") | {enabled, status}'`. On the 0.50.1 test instance it prints `{"enabled":false,"status":"disabled"}`, so the Save draft icon is absent.
- T3 Composer is the active composer. After opening Home, `agent-browser --session "$RUN" eval 'document.querySelectorAll("form[data-t3-composer]").length'` returns at least `1`. On the test instance it returns `1` on Home and `1` in a thread, `2` while a queued message is being edited. If it returns `0`, open **Settings → Appearance → Composer**, choose `T3 Composer`, and restore the mirrored choice afterwards.
- The model, provider, and effort names depend on the CLIs signed in on this host. Record names from a snapshot before changing anything, so every recipe can restore them. Never hardcode a model.
- Starred models live in plugin storage on the bb server, which is not mirrored, so the instance starts with no stars. Other runs on the same instance can leave stars; read `"$TB" plugin rpc call t3-composer starredModels --json | jq -c .models` first and leave it as you found it.
- **Send tripwire.** Record `"$TB" thread list --json | jq -c '[.threads[] | [.title, .status]]'` before and after each batch. A fixture whose status leaves `pending`, or a new thread, means something sent.
- **Free and paid paths.** Sending a message starts an agent turn, which is paid on every provider except the local fake agent. Each of these sends:
  - Enter without a highlighted suggestion, Ctrl+Enter, or the send button.
  - Enter or a click on a bb built-in `/` command.

  Every free recipe below avoids them.

- Fixtures for thread-surface checks: create one project and two idle threads, recording the printed ids:

  ```bash
  FX="$BB_THREAD_STORAGE/verify/$RUN-fixtures"; mkdir -p "$FX/verify-t3"
  git init -q "$FX/verify-t3" && printf 'hello\n' > "$FX/verify-t3/notes.md" && git -C "$FX/verify-t3" add -A && git -C "$FX/verify-t3" commit -q -m init
  "$TB" project create --name verify-t3 --root "$FX/verify-t3" --json | jq -r '.project.id // .id'
  AT=$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)   # macOS: date -u -v+7d +%Y-%m-%dT%H:%M:%SZ
  "$TB" thread spawn --project <t3-id> --title "T3 fixture A" --prompt hello --send-at "$AT" --json | jq -r '.thread.id // .id'
  "$TB" thread spawn --project <t3-id> --title "T3 fixture B" --prompt hello --send-at "$AT" --json | jq -r '.thread.id // .id'
  ```

- **Open a fixture thread** from the sidebar, never by URL. A URL open reloads the page. Run `agent-browser --session "$RUN" click '[data-gtd-row="<a-id>"] a[data-sidebar-thread-id]'` and `agent-browser --session "$RUN" wait '[data-app-composer-role="primary"] form[data-t3-composer]' --timeout 15000`.
- **Editor handle.** Call `$ED` the editor: `'form[data-t3-composer] [contenteditable="true"]'` on Home, and `'[data-app-composer-role="primary"] form[data-t3-composer] [contenteditable="true"]'` in a thread.
  - **Focus:** `agent-browser --session "$RUN" focus $ED`.
  - **Type:** `agent-browser --session "$RUN" keyboard type "<text>"`. `fill` does not reach the rich-text editor.
  - **Clear the draft:** focus `$ED`, then press `Control+a` and then `Backspace`. Always focus first, because Vimium takes bare keys outside the editor.
- **Menu wait.** Wait for a suggestion inside the typeahead menu with `agent-browser --session "$RUN" wait --fn '[...document.querySelectorAll("[data-promptbox-typeahead-menu] button")].some(b => b.textContent.includes("<text>"))' --timeout 15000`. `wait --text` would match the text just typed.

- **Renderer and tray (`t3-renderer`, `t3-tray`).** Open `"$URL"` and run `wait --text "New thread"`. Then run `agent-browser --session "$RUN" snapshot -i -c -s 'form[data-t3-composer]'`. The snapshot has textbox `Ask anything. @ to mention files, folders, or sections`, buttons `Prompt actions`, a model pill named after the model (such as `Opus 5.5`), `Effort: Medium`, `Permission mode`, and `Start voice input`, then the send button. On an empty Home draft the send button is disabled and named by its reason, `Enter a prompt or attach a file.`; in a thread it is `Submit (Enter)`. Measure the tray above the card with one probe: `agent-browser --session "$RUN" eval '(() => { const t = document.querySelector("[data-new-thread-footer]")?.getBoundingClientRect(); const f = document.querySelector("form[data-t3-composer]")?.getBoundingClientRect(); return t && f ? { trayTop: t.top, trayBottom: t.bottom, cardTop: f.top } : null })()'`. The tray sits above the card and tucks under its top edge: at 1920×1080 it printed `trayTop: 472`, `trayBottom: 520`, `cardTop: 508`, a 12px overlap. In fixture A, `[data-follow-up-composer][data-t3-composer-host]` wraps the card (`[data-app-composer][data-t3-composer-host]` does not match there).
- **Queued-message editor (`t3-renderer`).** Fixture A's scheduled `hello` shows in a `Queued messages` region. Its row buttons appear on hover, so `find role button click --name "Edit queued message 1"` reports the button covered; focus it instead and press Enter: `agent-browser --session "$RUN" focus 'button[aria-label="Edit queued message 1"]'` and `agent-browser --session "$RUN" press Enter`. Never press `Send queued message 1 now`. A second T3 card opens in the queue row (`form[data-t3-composer]` count `2`) holding `hello`, with `Stop editing queued message`, `Prompt actions`, bb's own `Provider, model and reasoning (Ctrl + Shift + M)` picker in place of the T3 pill, `Start voice input`, `Submit (Enter)`, and `Permission mode`. Leave with focus on `Stop editing queued message` and `Enter`. Whether the pickers are read-only was not checked. <!-- unverified: read-only pickers and Save draft absence (Drafts is off) -->
- **Tray keeper (`t3-tray-keeper`).** In fixture A at 1920 wide, `agent-browser --session "$RUN" eval '!!document.querySelector("[data-app-composer-role=\"primary\"] [data-follow-up-composer][data-t3-composer-host] > [data-follow-up-composer-footer]")'` returns `true`. Press `Escape` to blur, and the check stays `true`. Repeat at `set viewport 390 844 3` before focusing the editor: still `true`. Without the keeper, bb removes the row there. Restore `set viewport 1920 1080 2`. On a fixture thread with no worktree the tray row is 48px tall and holds only a hidden `Permission mode` button, so it looks empty.
- **Branch picker style (`t3-branch-style`).** `agent-browser --session "$RUN" eval '!!document.querySelector("style[data-t3-branch-picker-style]")'` returns `true` on any page. The fixture thread's tray has no branch control, so use Home with a git project chosen: `agent-browser --session "$RUN" click '[data-new-thread-footer] [aria-label="Branch"]'` (a `combobox` reading `Current ( master )`). While the picker is open, `eval '[document.querySelectorAll("[data-branch-picker-row]").length, document.querySelectorAll("[data-branch-picker-row][data-t3-branch-chosen]").length]'` printed `[3, 1]` (rows `Current`, `New branch`, `Checkout`). Press `Escape` to close it. The phone sheet styling was not checked. <!-- unverified: phone branch sheet -->
- **Plus menu (`t3-plus-menu`).** Run `agent-browser --session "$RUN" find role button click --name "Prompt actions"` and `wait --text "Attach files"`. A menu named `Prompt actions` lists `Attach files` and whichever of `Skills`, `Plan`, and `Goal` bb offers, then other plugins' items: on Opus 5.5 it listed `Attach files`, `Skills`, `Plan`, `Automation`, and `Plugin` (no `Goal`). Choose `Plan` with `find role menuitem click --name "Plan"`. The draft holds a `plan` pill, the `Permission mode` pill hides (plan mode), and nothing is sent. Clear the draft.
- **Model picker (`t3-model-picker`).** Record the pill's name first. Run `agent-browser --session "$RUN" click '[data-t3-model-picker-trigger]'` and `wait '[data-t3-model-search]'`.
  - The snapshot has combobox `Search models`, listbox `Models`, and options whose text reads `<model> | <provider> | Ctrl+N`, with `, favorite` added for a starred one.
  - The rail has `Favorites` and one button per provider (`Claude Code`, `Codex`, `Pi`, and others). An unavailable provider should read `<Provider>: Not ready.`; none was unavailable on the instance. <!-- unverified: Not ready label --> The picker opens on `Favorites` when any model is starred, otherwise on the current provider.
  - Type a recorded model word with `keyboard type "<word>"`. The list filters across every provider, and the first match is already highlighted. Press `Enter` to choose it, or `ArrowDown` first to choose the second (`sonnet`, `ArrowDown`, `Enter` chose `Sonnet 5`). The popover closes, and the pill's name becomes that model.
  - Reopen the picker and press `Control+2`. The second visible model is chosen.
  - Reopen it and press `Escape` to close without choosing.
  - Restore the recorded model by searching for it and pressing `Enter`.
- **Favorites (`t3-favorites`).** Open the picker, highlight a model, and press `Control+d`. The option's name gains `, favorite`, and the `Favorites` rail tab lists it. Read the store back with `"$TB" plugin rpc call t3-composer starredModels --json | jq -c .models`, which prints `[{"providerId":"claude-code","model":"claude-opus-5-5"}]`. Reload Home and reopen the picker. It opens on `Favorites` with the model first. Press `Control+d` on it again to unstar, and confirm that `.models` is `[]`. With no stars, the `Favorites` tab reads `Up and Down to move, Enter to choose, Control+D to add or remove a favorite.` and `No favorites yet`.
- **Effort and speed (`t3-effort`, `t3-speed`).** Record the pill's `Effort: …` name. Run `agent-browser --session "$RUN" click '[data-t3-traits-trigger]'` and `wait '[role="slider"][aria-label="Effort"]'`, then `agent-browser --session "$RUN" focus '[role="slider"][aria-label="Effort"]'`.
  - Press `ArrowLeft`, or `ArrowRight` at the lowest level. The slider's `aria-valuetext` and the pill's `Effort: …` name move one level (`Medium` to `Low` on Opus 5.5). `End` jumps to the top level (`Max`), `Home` to the lowest.
  - Away from the default level, a `menuitem` `Reset effort to <default>` appears; the default is the model's, not the composer's starting level (`Reset effort to High` on Opus 5.5, `Reset effort to Low` on GPT-6.2-Sol). Run `agent-browser --session "$RUN" find role menuitem click --name "Reset effort to High"`: the slider reads `High`.
  - Where the model offers tiers, the panel has a `menuitem` named `Speed: Normal. Switch to Fast`. Choosing it appends `· Fast` to the pill's name (`Effort: High · Fast`) and renames the item `Speed: Fast. Switch to Normal`. On Opus 5.5 and GPT-6.2-Sol the panel toggled only Normal and Fast. Choose it until it reads `Normal` again.
  - A model with no effort levels and no tiers shows no pill. That is not a gap.
  - Restore the recorded level and press `Escape`.
- **Daybreak (`t3-agent-switch`).** On a Codex model, the effort panel shows a switch under the slider. On `GPT-6.2-Sol` it is `switch "Daybreak Set by this model"`, unchecked and disabled. On a model that leaves it free, toggle it with `agent-browser --session "$RUN" find role switch click --name "Daybreak"`, then toggle it back. <!-- unverified: no free Daybreak model tried -->
- **Cycle shortcuts (`t3-model-shortcuts`).** Read the bindings with `"$TB" settings keyboard list --json | jq -c '[.bindings[] | select(.command | startswith("modelPicker.cycle")) | {command, key: .shortcut.key, mod: .shortcut.mod, alt: .shortcut.alt, shift: .shortcut.shift}] | unique'`. The instance has `cycleReasoning` `F10`, `cycleReasoningBackward` `F11`, `cycleModel` `Alt+m`, `cycleModelBackward` `Alt+Shift+m`, `cycleProvider` `Control+Alt+ArrowRight`, and `cycleProviderBackward` `Control+Alt+ArrowLeft`. With `$ED` focused: `F10` moved `Effort: Medium` to `High` and `F11` back; `Alt+m` moved `Opus 5.5` to `Fable 5.2` and `Alt+Shift+m` back; `Control+Alt+ArrowRight` switched to `GPT-6-Astra` and `Control+Alt+ArrowLeft` back to `Opus 5.5` within 3 seconds. The draft stays empty. Skip any command with no binding, and do not bind keys on live.
- **Permission mode (`t3-permission`).** Record the pill's label. Run `agent-browser --session "$RUN" find role button click --name "Permission mode"` and `wait --text "actions be approved?"`. The menu reads `How should Claude Code actions be approved?` and lists `menuitemradio` items `Accept Edits`, `Approve for me`, and `Full Access`, each with its `aria-checked`. The pill's text is the mode, such as `Approve for me` (with `Auto` as a second line on Home). Choose `Accept Edits` with `find role menuitemradio click --name "Accept Edits"`. The pill reads `Accept Edits`. If `Full Access` shows `Above the selected machine's permission limit…`, it is disabled. Report that, and use `Accept Edits` and `Approve for me` for the rest. Restore the recorded mode.
- **Kept pick across threads (`t3-permission-kept`).** Open fixture A from the sidebar and pick a mode other than its current one, preferring `Full Access`. Open fixture B from the sidebar (its pill reads `Approve for me`), then open fixture A again from the sidebar. A's pill still shows `Full Access`. A reload clears this page-scoped pick by design. Restore A's mode.
- **Keywords (`t3-keywords`).** Record the permission and effort pills, then focus `$ED`.
  - Type `keyboard type "#edits "`. The keyword leaves the draft, and the permission pill reads `Accept Edits`.
  - Repeat with `#auto ` for `Approve for me`, `#full ` for `Full Access`, and a recorded effort level such as `#low ` for `Effort: Low`.
  - For a model keyword, first star a model (see Favorites), then type one word of its id followed by a space. With only Sonnet 5.5 starred, `#sonnet ` switched the pill to `Sonnet 5.5` and left the draft empty. Unstar the model afterwards.
  - A keyword that names nothing, such as `#foo `, stays in the text.
  - Clear the draft, then restore the recorded mode, effort, and model through the pills.
- **Slash menu (`t3-slash-menu`).** Focus `$ED` and type `keyboard type "/"`. Wait on `agent-browser --session "$RUN" wait '[data-promptbox-typeahead-menu] button' --timeout 15000`. The menu fills in over seconds: at first it held only `handoff` and `plan`; after 4 seconds it held 115 entries under `Commands` and `Skills`. Press `ArrowDown` to move the highlight. Press `Tab`, not Enter, to insert the highlighted item as a pill without sending: `Tab` on `plan` left a `plan` pill. `Escape` closes the menu and leaves the `/` in the draft. Clear the draft. Never press Enter while the menu is loading or empty, because Enter then sends the draft.
- **Mention menu (`t3-mention-menu`).** In fixture A, focus `$ED`, type `keyboard type "@notes"`, and run the menu wait with `notes.md`. The menu reads `Workspace` `notes.md`. Press `Tab` to insert the file pill `notes.md`. Clear the draft. The loading, failure, and empty states were not provoked. <!-- unverified: Searching mentions…, Failed to load suggestions, Type to search mentions -->
- **Inline prompts (`t3-inline-prompts`).** Create a disposable user-tier skill in the instance's data directory: `mkdir -p "$INST/data/skills/verify-inline" && printf -- '---\nname: verify-inline\ndescription: verify\ninline: true\n---\nSay verify.\n' > "$INST/data/skills/verify-inline/SKILL.md"`. Within 2 seconds `"$TB" plugin rpc call t3-composer inlinePrompts --json | jq -c .names` prints `["verify-inline"]`. Type `keyboard type "/verify-inline"` and run the menu wait with `verify-inline`; the menu reads `Skills` `verify-inline` `verify`. Press `Tab`. A mention pill labelled `verify-inline` appears in the draft (the Zap icon was not checked). Clear the draft. To prove the body is sent, do the same in a fake-agent thread (see Sent entries), type ` inline check` after the pill, and press `Enter`: the `session/prompt` entry in `$EV/fake-agent.jsonl` holds the skill body `Say verify.` beside `inline check`.
- **Attachments (`t3-attachments`).** Work in fixture A, which has a project.
  - Write a disposable file with `printf 'x\n' > "$FX/verify-attach.txt"`.
  - Upload it: `agent-browser --session "$RUN" upload '[data-app-composer-role="primary"] form[data-t3-composer] input[type="file"]' "$FX/verify-attach.txt"`.
  - A file tile, button `verify-attach.txt`, with a `Remove verify-attach.txt` button appears above the text.
  - Focus `$ED`, type `@verify`, and run the menu wait with `verify-attach.txt`. The `Attachments` group lists the file first, above a `Threads` group. Image tiles, drop, paste, and the media preview were not driven. <!-- unverified: image tile, drop, paste, preview -->
  - Clear the draft, then press `find role button click --name "Remove verify-attach.txt"`. The tile leaves.
- **Context chips (`t3-context-chips`).** These need an annotation or comment mention from Agentation, Agent Annotations, or Source Control. Add one through that plugin's flow: stage two Agentation annotations, open a thread, choose its `2 annotations` staging button, then `Mention all`. A chip `2 annotations` with a `Remove 2 annotations` button appears above the text, no inline pill remains in the draft, and Agentation's staging button hides. `Remove 2 annotations` clears the chip and the staging button returns; the annotations stay staged. Comment chips were not driven. <!-- unverified: comment chips -->
- **Thread link paste (`t3-thread-link-paste`).** Open fixture B and save its URL with `agent-browser --session "$RUN" get url`. Open fixture A, focus `$ED`, and paste the URL through `eval --stdin`:

  ```bash
  cat <<'EOF2' | agent-browser --session "$RUN" eval --stdin
  (() => { const el = document.querySelector('[data-app-composer-role="primary"] form[data-t3-composer] [contenteditable="true"]');
    const data = new DataTransfer(); data.setData("text/plain", "<b-url>");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); return true })()
  EOF2
  ```

  The URL becomes a pill titled `T3 fixture B` holding a button `Open Thread: T3 fixture B`. The fixture thread URL is `$URL/projects/<t3-id>/threads/<b-id>`. Clear the draft.

- **Save draft (`t3-save-draft`).** Needs the Drafts built-in enabled; on the test instance it is disabled and no `Save draft` button renders, so this step was not driven. In fixture A, focus `$ED` and type `keyboard type "verify draft"`. Then run `agent-browser --session "$RUN" find role button click --name "Save draft"`. The editor clears. `"$TB" thread queue list <a-id> --json` lists a message with `content[0].text` `verify draft` held for `Draft` (the scheduled fixture entry reads `"state": "scheduled"`, `"waitingOn": {"kind": "time"}` for comparison), and fixture A's status stays `pending`. Delete it with `"$TB" thread queue delete <a-id> <message-id>`. If the hold fails, the message sends and starts a turn, so check the hold on a thread first. With an empty draft the button is disabled. <!-- unverified: Drafts disabled on the instance; enabling it and the hold were not driven -->
- **Keys (`t3-keys`).** Clear the draft and press `Shift+Enter`. Nothing is sent; the empty draft gains blank lines. Clear it. Type `keyboard type "one"`, press `Shift+Enter`, and type `keyboard type "two"`. The draft has two paragraphs (`$ED p` count `2`). Press `Escape`. Focus leaves the editor, and `agent-browser --session "$RUN" eval 'document.activeElement?.isContentEditable === true'` returns `false`. Refocus `$ED` and clear the draft. Blockquote exit and `Ctrl+Enter` were not driven; `Ctrl+Enter` sends. <!-- unverified: blockquote, alternate send -->
- **Sent entries (`t3-submit`, `t3-keys` sends and history, `t3-handoff`).** Each needs a sent turn. Send only in a thread on the local fake agent (SKILL.md, Free agent turns): `"$TB" thread spawn --project <t3-id> --provider acp-verify-fake --title "T3 fake" --prompt hello --json`, then open it from the sidebar. Its model pill reads `Agent default`. Any other provider is a paid turn.
  - **Send:** before sending, record the button states with a `requestAnimationFrame` probe that pushes the `aria-label` of `[data-app-composer-role="primary"] [data-t3-composer-stop]` and of the submit button into an array. Type `say ok` and press `Enter`. The states run `Submit (Enter)`, `Submitting...`, then `Stop run` (`[data-t3-composer-stop]`) while the fake turn runs, and the thread log holds `say ok`.
  - **History:** after the turn, press `ArrowUp` on an empty draft. The draft recalls `say ok`; `ArrowDown` empties it again.
  - **Alternate send:** type `alt ok` and press `Control+Enter`. On an idle thread it sends at once (the log holds `alt ok`, the queue stays empty). What it does while a turn runs was not driven. <!-- unverified: Ctrl+Enter during a running turn -->
  - **Handoff:** type `/handoff` followed by text, and send. bb opens its handoff, which can start a turn on another provider, so it was not driven. <!-- unverified: handoff may start a paid turn -->
- **Voice (`t3-voice`).** Pressing `Start voice input` needs a microphone, and headless Chrome has none. The button may carry bb's unsupported message as its name instead. Report it as unreachable here. On the instance the button is named `Start voice input`. <!-- unverified: no microphone -->
- **Compact (`t3-compact`).** Run `agent-browser --session "$RUN" set viewport 390 844 3` and reopen `"$URL"`.
  - A button `Attach files` replaces `Prompt actions`. On Home the `Permission mode` pill is disabled at this width.
  - `click '[data-t3-model-picker-trigger]'` opens a bottom sheet with heading `Model` and one tab per provider (`Favorites`, `Claude Code`, `Codex`, …), each model row with a star. No `Agents` section showed for Claude Code. <!-- unverified: Agents section -->
  - `click '[data-new-thread-footer] button[data-promptbox-project-control]'` opens a sheet with heading `Project`, searchbox `Search projects`, `Don't work in a project`, and `New project Add a folder on one of your machines`.
  - With a project chosen, `click '[data-new-thread-footer] button[aria-label="Environment"]'` (or `[aria-label="Machine"]`) opens a sheet headed `Run on` with an `Environment` section.
  - Capture the edges with `bun scripts/phone-shot.ts` as AGENTS.md describes. <!-- unverified: phone-shot not run -->
  - Restore `set viewport 1920 1080 2`.
- **Proof.** Before and after each change, run `agent-browser --session "$RUN" screenshot "$EV/t3-<state>.png"` and `agent-browser --session "$RUN" snapshot -i -c -s 'form[data-t3-composer]' > "$EV/t3-<state>.snapshot.txt"`.
- **Cleanup.** Clear the draft, and unstar every model you starred. Remove `"$INST/data/skills/verify-inline"`. Run `"$TB" project delete <t3-id> --yes`, then remove `$FX`.

## Gotchas

- Enter sends whenever no suggestion is highlighted, including while a `/` or `@` menu is still loading. Picking a bb built-in command with Enter or a click also sends at once. Use `Tab` to insert suggestions.
- Home autofocuses the editor, and drafts persist across reloads. Clear the draft before evidence. Vimium's bare keys act only outside the editor, so refocus the editor after `Escape`.
- `[data-t3-model-controls]` and the T3 model pill are absent while bb's own picker stands in: before the model's catalog entry loads, on queued or sent-message editors, and for models with a select-type agent option. bb's control shows instead. That is not a gap.
- The star button is aria-hidden and shows only on hover or a highlighted row, so headless Chrome cannot press it. Use `Control+d` from the search box. On a Mac browser the key is `Meta+d`, and the jump keys are `Meta+1`–`Meta+9`.
- Kept permission picks live only in the open page. A reload, a reconnect after a dropped realtime connection, or a started turn clears them.
- The permission pill hides while bb disables its own copy (plan mode, a permission snapshot, a pending question), and bb's copy shows the effective mode instead.
- `Collapse prompt box` and the compact one-line layout never render. The composer drops bb's collapse action and compact form, so there is nothing to drive.
- Voice input needs a microphone. Headless Chrome has none, so `t3-voice` is unreachable. The button's name may be bb's unsupported message.
- Save draft hides unless bb's Drafts plugin is enabled, and it is hidden on queued-message editors.
- `Effort` and `Speed` exist only for models that declare them, so a missing control on one model is not a gap.
- Queued-message row buttons (`Edit`, `Send … now`, `Delete`) show only on hover, and a click reports them covered. Focus them and press `Enter`, and never touch `Send queued message 1 now`.
- The `/` menu starts with only bb's built-in commands and fills in with skills over a few seconds. Wait for the item you want before `Tab`.
- The effort panel's `Reset effort to …` and `Speed: …` controls are `menuitem`s, not buttons; `find role button` misses them.
