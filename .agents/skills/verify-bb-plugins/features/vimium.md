# Vimium

Vimium labels every clickable element with hint letters so a keyboard user can click by typing, and adds single-key commands for navigation, pickers, and a cheatsheet.

## Sub-features

Each line names the state it needs beyond an empty instance: none, `threads` (idle fixture threads), `composer` (Home composer on a git fixture project), `conversation` (a thread with a long reply, one fake-agent turn), `split` (a split pane), `providers` (Codex and Claude Code model catalogs load), `agentation` (Agentation enabled), or `macOS`.

- `vimium-hints` shows hint markers over clickable elements and clicks the one whose letters are typed. Needs: none.
- `vimium-hints-cancel` removes every marker on `Escape`. Needs: none.
- `vimium-settings-hint` keeps `,` as the hint for Settings. Needs: none.
- `vimium-direct-keys` runs bound single-key commands, such as `f` for hints and `,` for Settings, outside text fields. Needs: none.
- `vimium-cheatsheet` opens the Vimium Cheatsheet page with every key and its effective binding. Needs: none.
- `vimium-pinned-labels` gives bb's stable controls fixed one-character labels and numbers sidebar thread rows `1` to `0`. Needs: none for the controls, `threads` for the numbers.
- `vimium-hint-typing` dims typed letters, hides labels that no longer match, steps back on `Backspace`, and exits on a key no label starts with. Needs: none.
- `vimium-hint-exit` exits hint mode on a window resize and on a modifier chord, which still reaches bb. Needs: none.
- `vimium-hint-text-field` focuses a text field instead of clicking it. Needs: none.
- `vimium-force-chord` makes `Cmd+Shift+F` mean the whole screen: it closes an open dropdown first and replaces a scoped prompt. Needs: none.
- `vimium-dropdown-reprompt` re-prompts inside a dropdown a hint or key opened, labels its choices `f`, `j`, `d`, `k`, and so on, and exits when the dropdown closes. Needs: none (More menu), `composer` (branch).
- `vimium-native-pickers` opens the project, machine, and model pickers without option hints, leaves every key to their search, and closes them on `Escape`. Needs: `composer`.
- `vimium-reasoning-hints` labels the reasoning choices `1`, `2`, `3` after a model is picked from a picker Vimium opened, and keeps them while the popup stays open. Needs: `composer`.
- `vimium-permission-hints` labels permission modes `a`, `s`, `d`, `f`, `g`, `h` and hands focus back to the composer after a pick. Needs: `composer`.
- `vimium-typing-guard` leaves a bare key typed in a text field to the field. Needs: none.
- `vimium-nav-keys` runs `n` New thread, `h` Home, `s` Search threads, and `,` Settings. Needs: none, `threads` for `n` from a thread.
- `vimium-search-fallback` opens Search threads through the Quick palette when no Search control is visible. Needs: none.
- `vimium-thread-step` steps `]` forward and `[` back through sidebar rows, wrapping. Needs: `threads`.
- `vimium-settle` settles the focused thread with `e`, a split pane's focused child included. Needs: `threads` and GTD Sidebar; `split` for the child case.
- `vimium-archive-undo` restores the newest archive with `E` (Shift+e), and makes the notification's Undo open the restored thread. Needs: `threads` and GTD Sidebar.
- `vimium-composer-keys` runs `i` focus composer, `m` model, `p` project, `l` machine, `b` branch, and `a` permission mode. Needs: `composer`.
- `vimium-model-keys` runs `F7` lower and `F9` raise reasoning effort, `F8` next favorite model, and `Shift+F8` next favorite provider. Needs: `composer`, `providers` for `Shift+F8`, favorites for `F8`; the media-key path needs `macOS`.
- `vimium-escape-sequences` runs `Escape` then `m` (provider), `r` (reasoning), `;` (speed), or `a` (Agentation) within 1.5 seconds. Needs: `composer`, `providers` for `m`, `agentation` for `a`.
- `vimium-scroll-keys` scrolls the conversation 60px with `j` and `k`, keeps scrolling while held, and jumps to the bottom with `J`. Needs: `conversation`.
- `vimium-timeline-quiet-zone` gives the conversation timeline no hints, and a timeline scroll keeps the prompt. Needs: `conversation`.
- `vimium-palette-search-guard` keeps bare-key bindings from firing while typing in Search threads or the Quick palette. Needs: none. This is the `vimium/palette-search-shortcuts` workaround.
- `vimium-command-palette` lists every Vimium command in the Quick palette and runs it from there. Needs: none.
- `vimium-keyboard-settings` lists every Vimium command under Settings → Keyboard. Needs: none.

## How to get to it (user POV)

- Press `Cmd+Shift+F` anywhere, the composer included.
- Press `f` outside a text field, once bb's `plugin:vimium/show-hints` command is bound to it.
- Press `?` (`Shift+/`) outside a text field for the cheatsheet, or open **Vimium Cheatsheet** from the Quick palette.
- Rebind the commands under **Settings → Keyboard**, or with `bb settings keyboard set plugin:vimium/<command> <key>`.
- Outside a text field, press a bound single key: `n`, `h`, `s`, `,`, `]`, `[`, `e`, `E`, `?`, `i`, `m`, `p`, `l`, `b`, `a`. The README's Direct keys section lists the bindings to set.
- Press `j`, `k`, or `J` in a thread with a conversation. These are Vimium's own keys and need no binding.
- Press `Escape`, then `m`, `r`, `;`, or `a` within 1.5 seconds, from the composer too.
- On a Mac, press `F7`, `F8`, `F9`, or `Shift+F8` as F-keys (hold fn, or remap the media keys in Karabiner-Elements as the README describes). They work from the composer too.
- Open the Quick palette (`Ctrl+K` on Linux, `Cmd+K` on Mac) and run any Vimium command by its title.

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin vimium`.
- The direct keys are bound. `up` mirrors live's bindings; check with `"$TB" settings keyboard list --json | jq -c '[.overrides[] | select(.command | startswith("plugin:vimium/"))]'`. The output includes `show-hints` on key `f`, `settings` on `,`, and `cheatsheet` on `/` with `shift: true`. Without them, the direct-key steps are unreachable: report that, and do not bind keys on live.
- Record every Vimium binding before the extended steps: `"$TB" settings keyboard list --json | jq -c '[.overrides[] | select(.command | startswith("plugin:vimium/")) | {command, key: .shortcut.key, shift: .shortcut.shift}]' > "$EV/vimium-bindings.json"`. The JSON has `bindings` and `overrides` arrays; each entry is `{command, shortcut: {key, mod, meta, control, alt, shift}}` with no platform field. On the 0.50.1 test instance all 20 Vimium commands are bound, including `effort-down` `F7`, `effort-up` `F9`, `next-favorite-model` `F8`, and `next-favorite-provider` `Shift+F8`, and they act in this Linux browser. A step for an unbound command is unreachable: report it with this file.

Fixtures for the extended steps:

- **Idle threads (`threads`).** Create one git project with a second branch and three idle threads, and record the printed ids:

  ```bash
  FX="$BB_THREAD_STORAGE/verify/$RUN-fixtures"; mkdir -p "$FX"
  git init -q "$FX/verify-vimium" && git -C "$FX/verify-vimium" commit -q --allow-empty -m init
  git -C "$FX/verify-vimium" branch verify-side
  "$TB" project create --name verify-vimium --root "$FX/verify-vimium" --json | jq -r '.project.id // .id'
  AT=$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)   # macOS: date -u -v+7d +%Y-%m-%dT%H:%M:%SZ
  for n in one two three; do
    "$TB" thread spawn --project <project-id> --title "verify-vimium $n" --prompt hello --send-at "$AT" --json | jq -r '.thread.id // .id'
  done
  ```

- **Home composer (`composer`).** Open `"$URL"` and read the composer's project: `agent-browser --session "$RUN" eval 'document.querySelector("[data-app-composer] [data-promptbox-project-control]")?.getAttribute("aria-label")'`. A fresh instance prints `"Project: No project"`. Pick the project: press `Escape`, then `p`, then `agent-browser --session "$RUN" find role option click --name "verify-vimium"`. The label becomes `Project: verify-vimium`, the tray gains `Environment` and `Branch` controls, and the choice survives a reload.
- **Conversation (`conversation`).** Build it with the local fake agent as the conversation section below describes; that turn is free. A paid provider is never needed.
- **Scroll probe.** The conversation scroller is the nearest scrolling ancestor of `[data-timeline-row-list="top-level"]`. Define it once per shell:

  ```bash
  AREA='(() => { let e = document.querySelector("[data-timeline-row-list=top-level]")?.parentElement; while (e && !/auto|scroll/.test(getComputedStyle(e).overflowY)) e = e.parentElement; return e; })()'
  ```

- **Visible markers.** A label that stops matching stays in the DOM with `display: none`, so count visible markers, not `.vimium-hint-marker`:

  ```bash
  VIS='[...document.querySelectorAll(".vimium-hint-marker")].filter(m => m.style.display !== "none").map(m => m.textContent)'
  ```

### Verified steps

- **Show hints.** On Home, press the chord. Run `agent-browser --session "$RUN" press "Meta+Shift+f"` and `agent-browser --session "$RUN" wait .vimium-hint-layer --timeout 5000`. `agent-browser --session "$RUN" get count .vimium-hint-marker` prints a number above 0, about 20 on an empty Home.
- **Pick the Settings hint.** Press `,`. Run `agent-browser --session "$RUN" press ","` and `agent-browser --session "$RUN" wait --url "**/settings" --timeout 5000`. The URL ends in `/settings`, and the marker count is 0.
- **Cancel.** Show hints again on Settings, then press `Escape`. Run `agent-browser --session "$RUN" press "Meta+Shift+f"`, `agent-browser --session "$RUN" wait .vimium-hint-marker`, `agent-browser --session "$RUN" press Escape`, and `agent-browser --session "$RUN" wait --fn '!document.querySelector(".vimium-hint-marker")' --timeout 3000`. The marker count is 0.
- **Direct `f`.** Run `agent-browser --session "$RUN" open "$URL/settings"` and `agent-browser --session "$RUN" wait --text "Appearance"`, then wait for the bindings to register (see Gotchas). Run `agent-browser --session "$RUN" press f` and `agent-browser --session "$RUN" wait .vimium-hint-marker --timeout 4000`. The marker count is above 0. Press `Escape` to clear the markers.
- **Cheatsheet.** Press `?` outside a text field. Run `agent-browser --session "$RUN" press "Shift+/"` and `agent-browser --session "$RUN" wait --url "**/plugins/vimium/cheatsheet" --timeout 5000`. The page shows `Show hints` and the other commands with their bound keys.
- **Proof.** While markers are visible, run `agent-browser --session "$RUN" screenshot "$EV/vimium-hints.png"` and save the marker letters with `agent-browser --session "$RUN" eval '[...document.querySelectorAll(".vimium-hint-marker")].map(m => m.textContent).join(" ")' > "$EV/vimium-markers.txt"`. The letters include `,`.

### No fixtures

- **Cheatsheet contents.** On the cheatsheet page, run `agent-browser --session "$RUN" eval '[...document.querySelectorAll("h2")].map(h => h.textContent)'`. It lists `Link hints`, `Navigation`, `Composer`, `Model`, `Escape shortcuts`, `Scrolling`, `Pinned hint labels`, and `Dropdowns`, after GTD Sidebar's `Next Action` shelf heading, which is also an `h2`. Each bound command row shows its key as key caps, and an unbound one shows `Unbound`. With the mirrored bindings no row reads `Unbound`, and the Model rows show `F9`, `F7`, `F8`, and `Shift + F8`. Save `agent-browser --session "$RUN" snapshot -c > "$EV/vimium-cheatsheet.snapshot.txt"` and compare each row with `$EV/vimium-bindings.json`.
- **`?` on the cheatsheet adds no history entry.** From Home, press `Escape`, then `Shift+/`, retrying per Gotchas, and `wait --url "**/plugins/vimium/cheatsheet" --timeout 5000`. Read `agent-browser --session "$RUN" eval 'history.length'`, press `Shift+/` again, and read it again: it is unchanged and the URL is still the cheatsheet. Run `agent-browser --session "$RUN" back` and `agent-browser --session "$RUN" wait --url "$URL/" --timeout 5000`. One `back` returns to the page before the cheatsheet.
- **Pinned labels.** On Home, press `Escape`, then `Meta+Shift+f`, and wait for `.vimium-hint-marker`. Run `agent-browser --session "$RUN" eval '[...document.querySelectorAll(".vimium-hint-marker")].map(m => m.textContent).filter(t => t.length === 1).sort().join(" ")'`. With the sidebar list navigation the instance mirrors, it prints `, 1 … 0 \ a e i k m n p q v`: `,` Settings, `\` right panel, `a` Prompt actions (`+`), `e` More, `i` composer input, `k` permission mode, `m` model, `n` New thread, `p` project, `q` left sidebar, `v` voice input, and digits for thread rows. `j` (send) appears only while the draft has text, since an empty draft's send button is disabled. `h` Home and `s` Search threads appear only in a layout that shows those controls; the list navigation has neither. The effort pill gets a two-character label. Every other label has two characters. Press `Escape`.
- **Hint typing.** Show hints and pick a two-character label. Run `agent-browser --session "$RUN" eval "($VIS).find(t => t.length === 2)"` and record its first character as `C`; it is a general-alphabet letter such as `d` or `f`. Press `C`. Then:
  - `agent-browser --session "$RUN" eval "($VIS).every(t => t.startsWith('C'))"` prints `true`, and the visible count dropped while `get count .vimium-hint-marker` did not change.
  - `agent-browser --session "$RUN" eval '[...document.querySelectorAll(".vimium-hint-marker")].filter(m => m.style.display !== "none").every(m => m.querySelector(".vimium-hint-typed").textContent === "C")'` prints `true`, and `agent-browser --session "$RUN" eval 'getComputedStyle(document.querySelector(".vimium-hint-typed:not(:empty)")).color'` prints `rgb(184, 162, 90)`, the dimmed colour.
  - Press `Backspace`. `agent-browser --session "$RUN" eval "($VIS).length === document.querySelectorAll('.vimium-hint-marker').length"` prints `true`: every label is back and none is dimmed.
  - Press `Backspace` again with nothing typed. The markers stay.
  - Press a key no label starts with. Confirm first with `agent-browser --session "$RUN" eval "!($VIS).some(t => t.startsWith('z'))"`, then press `z` and wait with `wait --fn '!document.querySelector(".vimium-hint-marker")' --timeout 3000`. Hint mode exits and nothing was clicked: the URL is unchanged.
  - Show hints again and type a full two-character label from a button outside the composer. The button acts, and the markers are gone. For example, the sidebar's `Tasks` button had label `df`, and typing it opened `/plugins/scott-tasks/tasks`.
- **Exit on resize.** Show hints, then run `agent-browser --session "$RUN" set viewport 1600 900 2` and `wait --fn '!document.querySelector(".vimium-hint-marker")' --timeout 3000`. Restore with `agent-browser --session "$RUN" set viewport 1920 1080 2`.
- **Exit on a chord.** Show hints, then press `Control+k`. The markers clear, and the key reaches bb: `agent-browser --session "$RUN" wait '[role="dialog"] input[aria-label="Search commands"]' --timeout 3000` finds the Quick palette. Press `Escape`. Do not use `Control+f` for this check: bb's `window.find` and `browser.find` bindings are desktop-only, so in the web UI the markers clear but nothing visible opens.
- **Text field hint.** On Home, press `Escape`, show hints, and press `i`. Run `agent-browser --session "$RUN" eval 'document.activeElement?.matches("[data-app-composer] [role=textbox]")'`. It prints `true`, and the composer draft is unchanged.
- **Typing guard.** With the composer focused, press `n`, then run `agent-browser --session "$RUN" get url`. The URL is unchanged, and `agent-browser --session "$RUN" eval 'document.querySelector("[data-app-composer] [role=textbox]").textContent'` ends in `n`. Press `Backspace` to clear the draft.
- **Dropdown re-prompt.** On Home, press `Escape`, show hints, and press `e` for More. Run `agent-browser --session "$RUN" wait '[role="menu"]' --timeout 3000` and `agent-browser --session "$RUN" wait .vimium-hint-marker --timeout 3000`. The labels, in order, start `f`, `j`, `d`, `k`: `agent-browser --session "$RUN" eval "($VIS).join(' ')"` printed `f j d k s l a h g e` for a ten-item More menu. Every marker sits on a menu item. Click outside the menu (`agent-browser --session "$RUN" mouse move 1200 300`, `mouse down`, `mouse up`): the menu and its markers both go. `Escape` is two steps: the first removes only the markers and leaves the menu open; a second `Escape` closes the menu.
- **Force chord over a dropdown.** Open More as above so its scoped markers show, record the visible count, then press `Meta+Shift+f`. Run `agent-browser --session "$RUN" wait --fn '!document.querySelector("[role=menu]") && document.querySelectorAll(".vimium-hint-marker").length > 0' --timeout 3000`. The menu closed, and the marker count is the whole-screen count again with `,` among the labels. Press `Escape`.
- **`,`.** From Home, press `Escape`, then `,` and `wait --url "**/settings" --timeout 5000`.
- **`h`.** From Settings, press `h` and `wait --url "$URL/"`, retrying per Gotchas. It needs the navigation rail's `Home` button. The instance mirrors the sidebar list navigation, which has none, so `h` does nothing there (the URL stays `/settings`). Report it unreachable unless the run owns the Appearance navigation choice. <!-- unverified: no Home control in the mirrored list navigation -->
- **`s` and the palette search guard.** From Home, press `Escape`, then `s`. Run `agent-browser --session "$RUN" wait '[role="dialog"] input[aria-label="Search threads"]' --timeout 5000`. Press `h`, `e`, `n`, `s` as four separate `press` calls; `type` and `fill` can skip the keydowns this checks. Then `agent-browser --session "$RUN" eval 'document.querySelector("[role=dialog] input[aria-label=\"Search threads\"]")?.value'` prints `"hens"`, the dialog is still open, and the URL is unchanged. Press `Escape`. Repeat in the Quick palette: press `Control+k`, wait for `[role="dialog"] input[aria-label="Search commands"]`, press the same four keys, and check that its value is `"hens"`. Press `Escape`.
- **Search fallback.** Confirm no Search threads control is visible: `agent-browser --session "$RUN" eval '[...document.querySelectorAll("button[aria-label^=\"Search threads\"], [data-sidebar-navigation-item=\"__bb__/search-threads\"]")].some(e => e.checkVisibility())'` prints `false`. The mirrored list navigation has no Search control even with the sidebar open, so the `s` step above already took this path; repeat it with the sidebar collapsed (show hints and press `q`). Press `s`. `agent-browser --session "$RUN" wait '[role="dialog"] input[aria-label="Search threads"]' --timeout 5000` succeeds; the Quick palette opened and drilled into Search threads. Press `Escape`, then show hints and press `q` to expand the sidebar again.
- **Quick palette entries.** Press `Control+k` and wait for `input[aria-label="Search commands"]`, then run `agent-browser --session "$RUN" keyboard type "vimium cheat"`. Options `Vimium Cheatsheet` (the page entry) and `Open the Vimium cheatsheet` show, each option's text ending in `Vimium` and its key, such as `Shift + /`. Choose `Open the Vimium cheatsheet` and press `Enter`; `wait --url "**/plugins/vimium/cheatsheet" --timeout 5000`. Reopen the palette and confirm each title shows when searched: `Show hints`, `Settle the focused thread`, `Undo the latest archive`, `Open permission mode`, `Open the model picker`, and `Next favorite provider, same model size` (listed beside `Next favorite model on this provider`).
- **Palette runs a page command.** Run `Show hints` from the palette: the palette closes and the page shows its full marker set (46 on Home with fixtures). Run `Open the model picker`: the model trigger reports `aria-expanded="true"`. Report a run that labels only the closing palette, or that does nothing, as a product gap.
- **Settings → Keyboard.** Open `"$URL/settings"`, run `agent-browser --session "$RUN" find role link click --name "Keyboard"`, and the URL becomes `/settings/keyboard`. Save `agent-browser --session "$RUN" snapshot -c > "$EV/vimium-keyboard.snapshot.txt"`. It has 20 rows labelled `Plugin: vimium`, each with a button `Record shortcut for <title>, current shortcut <key>`, such as `Record shortcut for Show hints, current shortcut F` and `Record shortcut for Next favorite provider, same model size, current shortcut Shift + F8`. Compare each with `$EV/vimium-bindings.json`.

### With idle threads

- **Thread digits.** On Home, press `Escape`, show hints, and read the numbered labels: `agent-browser --session "$RUN" eval "($VIS).filter(t => /^[0-9]$/.test(t))"` includes `1`, `2`, `3`. Record the sidebar order with `agent-browser --session "$RUN" eval '[...document.querySelectorAll("[data-sidebar-thread-shortcut-target]")].filter(e => e.checkVisibility()).map(e => e.getAttribute("data-sidebar-thread-id"))' > "$EV/vimium-rows.json"`. Press `2`. The URL, `/projects/<project-id>/threads/<id>`, holds the second row's id.
- **Step through threads.** From Home, press `Escape` and `]`: the URL holds the first row's id. Press `Escape`, then `]` twice more, and check each id in list order. From Home, `[` opens the last row; `]` from there wraps to the first row, and `[` returns to the last. Wait on each with `agent-browser --session "$RUN" wait --url "**/threads/<id>" --timeout 5000`. Rows in the sidebar's More popover are skipped.
- **`n` from a thread.** On a fixture thread, press `Escape`, then `n`. The URL becomes `$URL/` and the new-thread composer (`[data-new-thread-footer]`) shows.
- **Settle.** This needs GTD Sidebar, which draws a `Settle` button beside each row. Open `verify-vimium three` from its row (`agent-browser --session "$RUN" click '[data-gtd-row="<three-id>"] a[data-sidebar-thread-id]'`), press `Escape`, then `e`. Wait for the archive notification with `agent-browser --session "$RUN" wait '[data-sonner-toast].bb-app-toast' --timeout 5000`, not `--text`; its text reads `Thread archived` `verify-vimium three` `Undo`. bb then opens the next row's thread and focuses its composer. Confirm the archive with `"$TB" thread show <three-id> --json | jq .thread.archivedAt`, which prints a timestamp. On a non-thread page such as Settings, `e` does nothing.
- **Undo with `E`.** While that notification shows, read its title: `agent-browser --session "$RUN" eval '[...document.querySelectorAll("[data-sonner-toast].bb-app-toast")].map(t => t.textContent)'`. Wait about 1.5 seconds and run `agent-browser --session "$RUN" eval 'document.activeElement.blur()'`, because bb focuses the advanced-to thread's composer and `Shift+E` would type `E` into a draft. Then press `Shift+E` while the notification still shows. Expected: `agent-browser --session "$RUN" wait --url "**/threads/<three-id>" --timeout 5000` passes, `"$TB" thread show <three-id> --json | jq .thread.archivedAt` prints `null`, and GTD Sidebar's `Settled` shelf no longer lists it. On bb 0.50.1 nothing happens: the notification's title is `Thread archived`, and Vimium acts only on one titled `Thread Archived` (product gap). Restore with `"$TB" thread unarchive <three-id>`. <!-- unverified: Shift+E does nothing on bb 0.50.1 (toast title case) -->
- **Undo button opens the thread.** Settle `verify-vimium three` again with `e`, press `Escape`, then choose the notification's Undo: `agent-browser --session "$RUN" find role button click --name "Undo"`. `archivedAt` reads `null` (bb's own Undo). Expected: the URL becomes the restored thread's. On bb 0.50.1 it stays on the thread bb advanced to, for the same title mismatch (product gap). <!-- unverified: Undo restores but does not open the thread on bb 0.50.1 -->

### Home composer on the fixture project

These were driven with T3 Composer as the active composer, which the instance mirrors. To leave the composer before a direct key, run `agent-browser --session "$RUN" eval 'document.activeElement.blur()'`; see Gotchas for why a plain `Escape` is unreliable before `m`.

- **`i`.** Press `i`. `document.activeElement` matches `[data-app-composer] [role=textbox]`.
- **`p` project picker.** Press `p`. Run `agent-browser --session "$RUN" wait '[data-app-composer] [data-promptbox-project-control][aria-expanded="true"]' --timeout 3000`, then `agent-browser --session "$RUN" wait 1000` and `get count .vimium-hint-marker`, which prints 0. The desktop picker lists projects as `option`s with `New project` and `No project` and has no search field, so typed keys change nothing; press `k`, `b`: no marker appears and the URL stays. Press one `Escape`: the picker closes and the composer is unchanged.
- **`l` machine picker.** Press `l`. The `Environment` button reports `aria-expanded="true"`, its options are `Project checkout`, `Worktree`, and `Reuse existing`, and no markers show after a second. Press `Escape`.
- **`m` model picker.** Press `m`. The trigger, `[data-app-composer] button[data-t3-model-picker-trigger]` with T3 Composer (`[data-app-composer] button[aria-label^="Provider, model"]` with bb's composer), reports `aria-expanded="true"`, and no markers show after a second. Press `f`: `agent-browser --session "$RUN" eval 'document.querySelector("[data-t3-model-search]").value'` prints `"f"`, and no markers appear. Clear it with `Backspace`, then `Escape`.
- **Reasoning number hints.** These need bb's own model picker, whose popup holds a `[role="radiogroup"][aria-label="Reasoning"]` group. With T3 Composer, picking a model in the popup opened by `m`, by click or by typing its name and pressing `Enter`, closes the popup, no Reasoning group exists, and no numbers appear: this step is unreachable while T3 Composer is the composer, and switching composers is a global Appearance choice. With bb's composer: open the picker with `m`, record the trigger text, pick a different model inside the popup, run `agent-browser --session "$RUN" wait 2000` and `agent-browser --session "$RUN" eval "($VIS).join(' ')"`, which prints `1 2 3` and more for each level, in displayed order, all inside the Reasoning group. Press `2`: the second level becomes checked, and after another 2-second wait the numbers show again. Press `Escape`: the markers and the picker both close. Restore the original model and reasoning. <!-- unverified: needs bb's built-in composer -->
- **`b` branch picker.** Press `b`. The Branch dropdown opens with labels at once: `f` `Current: master`, `j` `New branch`, `d` `Checkout`. Press `d`. It re-prompts inside the checkout list: `f` the `Search branches` field, `j` `Current`, `d` `New branch`, `k` `Checkout`, then one label per branch, such as `s` `master` and `l` `verify-side`; read them with `agent-browser --session "$RUN" eval "($VIS).join(' ')"`. Press the label of `verify-side`. The `Branch` control reads `Checkout:verify-side`, the markers clear, and `document.activeElement` is the composer textbox within a second. Restore with `b` and the `Current` label.
- **`a` permission mode.** Press `a`. The `Permission mode` menu opens. Expected: labels `a`, `s`, `d`, `f`, `g`, `h` in order, one per mode, followed by `q`-prefixed labels for anything else; picking one updates the button and returns focus to the composer textbox. With T3 Composer the menu opens with no markers, both by `a` and by the `k` hint: its `Accept Edits`, `Approve for me`, and `Full Access` items are `div[role="menuitemradio"][tabindex="-1"]`, which Vimium does not hint (product gap). Press `Escape`. <!-- unverified: no permission hints under T3 Composer -->
- **Model keys.** Read the bindings from `$EV/vimium-bindings.json`. On the test instance they are bound with no platform and reach this browser, so no stand-ins are needed. If a run finds them missing, bind test-only stand-ins on the test instance only (`"$TB" settings keyboard set plugin:vimium/effort-down F7 --platform linux`, and likewise `effort-up F9`, `next-favorite-model F8`, `next-favorite-provider Shift+F8`), say so in the result, and reset them afterwards.
  - Read the level with `agent-browser --session "$RUN" eval 'document.querySelector("[data-t3-traits-trigger]")?.getAttribute("aria-label")'`. On Opus 5.5 from `Effort: Medium`, `F9` stepped through `High`, `Extra High`, `Ultracode`, and `Max`, and a fifth `F9` stayed at `Max`; `F7` stepped down to `Low` and stopped there.
  - `F8` steps to the next favorite model on this provider. Favorites are stored per bb server: star two models first (open the picker by clicking `[data-t3-model-picker-trigger]`, press `Control+d` on the highlighted model, `ArrowDown` twice, `Control+d` again), and confirm with `"$TB" plugin rpc call t3-composer starredModels --json | jq -c .models`. With `Opus 5.5` and `Haiku 5.5` starred, `F8` alternated between them. Afterwards unstar both so `.models` is `[]`.
  - `Shift+F8` switches provider, landing on the same size of model: Opus 5.5 became `GPT-6.2-Sol` within 2 seconds, and a second press returned to `Opus 5.5`. Read the trigger text with `eval 'document.querySelector("[data-t3-model-picker-trigger]").textContent'`; allow up to 15 seconds. A failure shows an error toast.
  - Press each key from inside the composer too: `F9` and `F7` still act, and the draft stays empty.
- **Escape sequences.** Each runs from the composer: focus `[data-app-composer] [role=textbox]`, then press `Escape` and the key as consecutive `press` calls.
  - `Escape`, `r` steps reasoning forward and wraps from the top level to the lowest (`Max` to `Low` on Opus 5.5).
  - `Escape`, `;` cycles `Normal`, `Fast`, `Ultrafast` for a model that offers them: on `GPT-6.2-Sol` the pill's name went `Effort: Medium`, `Effort: Medium · Fast`, `Effort: Medium · Ultrafast`, `Effort: Medium`. On Opus 5.5 it changed nothing and typed nothing, although T3 Composer's effort panel offers `Speed: Normal. Switch to Fast` for that model; treat that as a possible product gap to confirm.
  - `Escape`, `m` switches provider like `Shift+F8`. Wait up to 15 seconds for the trigger text. Repeat to switch back. In an existing thread this prepares bb's provider handoff for the next send.
  - `Escape`, `a` should turn on Agentation feedback mode when Agentation is enabled: `agent-browser --session "$RUN" eval 'getComputedStyle(document.querySelector("agentation-toolbar").shadowRoot.querySelector("[data-agentation-toolbar]")).display'` changes from `"none"` to `"block"`. On the test instance it stays `"none"` while the footer's `Toggle Agentation (⌃ ⇧ F)` button turns it on: Vimium looks for a button named `Toggle Agentation feedback mode` (product gap). <!-- unverified: Escape, a does nothing on the test instance -->
  - Cancel: press `Escape`, then `x`, then `m`. The model picker opens (`aria-expanded="true"`) and the model is unchanged, not a provider switch.

### With a conversation (one fake-agent turn)

The `conversation` fixture needs a long reply. Use the local fake agent (SKILL.md, Free agent turns) rather than a paid provider. bb joins single newlines into one paragraph, so write blank-line-separated lines: `for i in $(seq 1 300); do printf 'line %d\n\n' $i; done > "$EV/reply.md"`, then `"$TB" thread spawn --project <project-id> --provider acp-verify-fake --title "verify-vimium scroll" --prompt "long reply" --json | jq -r '.thread.id'` and `"$TB" thread wait <scroll-id> --timeout 60`. Open it from its sidebar row and `wait --text "line 300"`. The scroller is the `thread-scrollbar` element `$AREA` finds; `MAX` was 10351.

- **Scroll steps.** Run `agent-browser --session "$RUN" eval 'document.activeElement.blur()'` and read the position: `agent-browser --session "$RUN" eval "(a => [a.scrollTop, a.scrollHeight - a.clientHeight])($AREA)"`. The first number equals the second, `MAX`, which must be at least 300. Then wait on each result within 1px:
  - `k`: `wait --fn "(a => Math.abs(a.scrollTop - (MAX - 60)) <= 1)($AREA)" --timeout 3000`.
  - `k` again: `MAX - 120`.
  - `j`: `MAX - 60`.
  - `J` (`Shift+j`): `MAX`.
  - `j` at the bottom stays at `MAX`.
  - Scroll to the top with `agent-browser --session "$RUN" eval "($AREA).scrollTop = 0"`, wait a second, then press `k`: it stays at 0. Press `k` at once after setting 0 and bb may still be pinning the view to the bottom, so the reading starts from `MAX`.
- **Held key.** From `MAX`, run `agent-browser --session "$RUN" keydown k`, `agent-browser --session "$RUN" wait 600`, and `agent-browser --session "$RUN" keyup k`. The scroller moved more than one step (`MAX` to `MAX - 652`), and it stops changing after the keyup. A fixed wait is right here, because the hold time is the input.
- **Keys in the composer.** Press `i`, then `j`. The draft ends in `j` and `scrollTop` is unchanged. Clear the draft.
- **Timeline quiet zone.** Show hints on the conversation. The timeline has controls, `agent-browser --session "$RUN" eval 'document.querySelectorAll("[data-timeline-row-list] button").length'` prints more than 0 (13 here), yet no marker sits on one. `elementFromPoint` at a marker returns the marker itself, so match markers to targets by position instead: for each `.vimium-hint-marker`, find the candidate whose clamped `getBoundingClientRect()` left and top equal the marker's `style.left` and `style.top`, and count those inside `[data-timeline-row-list], [data-timeline-file-diff]`. It prints 0. The context-window tracker gets no marker either.
- **Timeline scroll.** With markers showing, run `agent-browser --session "$RUN" eval "($AREA).scrollTop -= 200"` and `agent-browser --session "$RUN" wait 300`. In this layout the markers clear (58 to 0), because the scroller also holds hinted controls outside the timeline: the follow-up composer's textbox, `Prompt actions`, model, `Permission mode`, `Start voice input`, and `New thread in this environment`. That matches the rule that a scroll of any container holding a hinted control exits hints, so it is not a gap. A layout whose scroller holds only the timeline should keep the markers. <!-- unverified: scroller holding only the timeline --> Press `Escape`.

### With a split pane

- **Open a split.** Open `verify-vimium one` from its row. Focus `verify-vimium two`'s row link (`agent-browser --session "$RUN" focus '[data-gtd-row="<two-id>"] a[data-sidebar-thread-id]'`), press `Shift+F10`, and run `agent-browser --session "$RUN" find role menuitem click --name "Open in split"`. `verify-vimium two` opens in a right-hand pane and takes focus: the URL holds `<two-id>`, its row carries `data-sidebar-thread-focused="true"`, and `verify-vimium one`'s row carries `"false"`.
- **Settle the focused child.** Press `Escape`, then `e`. `"$TB" thread show <two-id> --json | jq .thread.archivedAt` prints a timestamp, `<one-id>` stays `null`, and the URL moves to `<one-id>`. Restore with the notification's `Undo` (`Shift+E` does not act on bb 0.50.1; see Gotchas), which also reopened `<two-id>`.
- **Collapsed child.** Collapse the child's row and press `e` again: nothing is archived. <!-- unverified: not driven -->

### macOS only

- **Media keys.** On a Mac with bb in front, press `F7`, `F8`, `F9`, and `Shift+F8` with fn held, or through a Karabiner-Elements remap. They act as in the model keys step. Headless Chrome on Linux cannot show this path: hand it off as not verified on device.

### Cleanup

- Restore what the extended steps changed: the composer's model, reasoning, speed, provider, branch, and permission mode; t3-composer favorites; the left sidebar; the viewport; Agentation feedback mode; and any stray draft.
- Remove any test-only bindings with `"$TB" settings keyboard reset plugin:vimium/<command> --platform linux` for each one set, <!-- unverified: the verification run bound none --> then run `bun scripts/test-instance.ts sync` and compare `"$TB" settings keyboard list --json` with `$EV/vimium-bindings.json`.
- Run `"$TB" project delete <project-id> --yes`, then remove `$FX`.

## Gotchas

- bb registers plugin keybindings a few seconds after the page shows `New thread`. A bound key pressed earlier does nothing, while the `Cmd+Shift+F` chord already works. No DOM signal marks readiness. Before a direct-key step, retry up to 10 times: press the key, wait 1 second for its result, and press `Escape` between tries. Report the key only after every try fails.
- Home autofocuses the composer, and a bare key there types into the draft, which persists across reloads. Press `Escape` before a direct key on Home, and clear a stray draft before capturing evidence.
- `Escape` then `a`, `m`, `r`, or `;` within 1.5 seconds runs a provider or Agentation sequence instead of a direct key. An `Escape` pressed to leave the composer starts that window; one pressed while markers show does not. In the retry loop above, never retry `m` or `a` straight after the `Escape`.
- After an `Escape` out of the Home composer, a direct `m` was unreliable even past the window: in two rounds of waits of 2, 3, and 4 seconds it opened the picker three times and typed `m` into the draft three times, with no pattern by wait length. After `agent-browser --session "$RUN" eval 'document.activeElement.blur()'` instead, `m` opened the picker every time. Leave the composer that way before `m`, and read the draft afterwards.
- On Settings, an `Escape` with no markers showing closes Settings and returns Home. Do not press `Escape` between retries there.
- Settling a thread opens the next row's thread and focuses a composer about a second later, so an `Escape` pressed at once can come too early. A bare key pressed next, such as `Shift+E` or `h`, then types into a draft. Wait about 1.5 seconds, run `eval 'document.activeElement.blur()'`, check `document.activeElement` is `BODY`, then press the key; clear any draft it left.
- The test instance is shared: other agents' fixture rows sit in the sidebar and come and go, so digit labels and `]`/`[` order shift between runs. Record the row order immediately before each step.
- Hints exit on a window scroll, on a scroll of any container holding a hinted control, and on a resize, so capture the screenshot before the next action. A scroll inside the conversation timeline alone keeps them.
- The chord is `Meta+Shift+f` on every platform, including Linux. `Control+Shift+f` is Agentation's toolbar toggle.
- A hint that stops matching keeps its node with `display: none`. Count visible markers, not `.vimium-hint-marker`.
- While the project, machine, or model picker is open, every key goes to its search and no Vimium command runs. Close it before the next direct key.
- Reasoning number hints follow only a picker Vimium opened with `m` or the `m` hint. Opening it by click, or clicking the trigger again, turns them off for that popup.
- Check `$EV/vimium-bindings.json` before calling a Model command unreachable. On the test instance the four Model commands mirrored with no platform and act in this Linux browser. Say when a step used test-only stand-in bindings.
- T3 Composer, which the instance mirrors as the composer, changes two Vimium paths: picking a model closes its popup and there is no Reasoning group, so reasoning number hints cannot appear, and its permission items get no hints.
- `h` presses the navigation rail's Home button. With the list navigation layout, there is no Home control, and `h` does nothing.
- `e` needs a `Settle` button beside the row, which GTD Sidebar provides. bb's own sidebar has none.
- `E` acts only on a visible archive notification titled `Thread Archived`. bb 0.50.1 titles it `Thread archived`, so `Shift+E` and the Undo-opens-thread behavior do nothing there; report them as a product gap rather than retrying. The notification leaves after a few seconds.
- During a running agent turn, the composer controls the run locks and `Scroll to latest event` get no hints.
- `Shift+F8` and `Escape`, `m` fetch the other provider's models, which can take seconds. Wait on the trigger text, not a fixed sleep.
