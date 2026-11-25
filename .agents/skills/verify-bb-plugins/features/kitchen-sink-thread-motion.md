# Kitchen Sink: thread motion

Kitchen Sink fades a newly opened conversation in over 180 ms, skipped under reduced motion, and adds a **Jump to latest event** command (default `Mod+Shift+J`) that scrolls the current thread's timeline to its live tail. In a split layout the command scrolls the pane showing the current thread.

## Sub-features

- `ks-thread-fade` fades a newly mounted conversation in over 180 ms ease-out; updates to an open conversation do not restart it.
- `ks-fade-reduced-motion` turns the fade off under `prefers-reduced-motion: reduce`.
- `ks-jump-palette` lists **Jump to latest event** (tagged `Kitchen Sink`) in bb's command palette on thread surfaces only.
- `ks-jump-shortcut` runs it from `Mod+Shift+J`, rebindable as `plugin:kitchen-sink/jump-to-latest-event` in Keyboard settings.
- `ks-jump-scroll` scrolls the timeline to its bottom, through bb's **Scroll to latest event** button when it shows.
- `ks-jump-split` scrolls the pane whose thread is current in a split layout, not another pane.

## How to get to it (user POV)

- Open or switch to any thread; the fade plays as the conversation mounts.
- Open bb's command palette (`Mod+K`, the `palette.open` binding; the search box is `Search commands`) and choose **Jump to latest event**.
- Press `Mod+Shift+J` (`Ctrl+Shift+J` on Linux) on a thread.
- Rebind or clear it under **Settings → Keyboard** (`/settings/keyboard`), entry **Jump to latest event** marked `Plugin: kitchen-sink`.

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin kitchen-sink`.
- A fixture project and an idle thread exist, as in [thread details](kitchen-sink-thread-details.md).
- The fade probe and `ks-jump-scroll` need a thread with events, and the scroll needs a timeline taller than the pane. Make one with the free fake agent (SKILL.md **Free agent turns**): write a long reply, spawn one turn, and restore the short reply:

  ```bash
  { echo "Long fixture reply."; for i in $(seq 1 150); do echo; echo "Paragraph $i of the long fixture reply."; done; } > "$EV/reply.md"
  "$TB" thread spawn --project <ks-project-id> --provider acp-verify-fake --title "KS long" --prompt hello --json | jq -r '.thread.id // .id'
  "$TB" thread wait <ks-long-id>
  echo "verify fake agent: ok" > "$EV/reply.md"
  ```

- Plugin keybindings register a few seconds after `New thread` renders. Wait before pressing the shortcut.

- **Fade rule.** Open the fixture thread with `agent-browser --session "$RUN" open "$URL/projects/<ks-project-id>/threads/<ks-thread-id>"` and wait for its host name in the card. Confirm the plugin's rules are loaded:

  ```bash
  agent-browser --session "$RUN" eval '[...document.styleSheets].flatMap(s=>{try{return [...s.cssRules]}catch{return []}}).flatMap(r=>r.cssRules?[r,...r.cssRules]:[r]).map(r=>r.cssText).filter(t=>t.includes("kitchen-sink-thread-reveal"))'
  ```

  It returns the `[data-timeline-row-list="top-level"] { animation: 0.18s ease-out … kitchen-sink-thread-reveal; }` rule, the `@keyframes kitchen-sink-thread-reveal` opacity 0→1 rule, and a `@media (prefers-reduced-motion: reduce)` rule setting `animation: … none`.

- **Fade on an element.** Open `<ks-long-id>` and wait for `Paragraph 150`. Run `agent-browser --session "$RUN" eval '(() => { const e = document.querySelector("[data-timeline-row-list=\"top-level\"]"); return e ? [getComputedStyle(e).animationName, getComputedStyle(e).animationDuration] : null; })()'`. It returns `["kitchen-sink-thread-reveal", "0.18s"]`. A scheduled fixture thread has no timeline list, so the probe returns `null` there.
- **Reduced motion.** Emulate it with `agent-browser --session "$RUN" set media dark reduced-motion`, confirm with `agent-browser --session "$RUN" eval 'matchMedia("(prefers-reduced-motion: reduce)").matches'` returning `true`, reopen `<ks-long-id>`, and rerun the element probe: `animationName` returns `"none"`. Restore with `agent-browser --session "$RUN" set media dark`; the same `matchMedia` check returns `false` and `(prefers-color-scheme: dark)` stays `true`.
- **Thread marker.** Run `agent-browser --session "$RUN" eval '[...document.querySelectorAll("[data-kitchen-sink-thread]")].map(e => e.getAttribute("data-kitchen-sink-thread"))'`. It returns one entry per visible thread pane, here `["<ks-thread-id>"]`. The marker is a hidden span and draws nothing in the header.
- **Palette entry.** Press `Escape`, then `agent-browser --session "$RUN" press Control+k` and `agent-browser --session "$RUN" keyboard type "Jump to latest"`. `agent-browser --session "$RUN" snapshot -i -c` shows `combobox "Search commands"` and `option "Jump to latest event Kitchen Sink"`; a screenshot shows the row's shortcut hint `Ctrl + Shift + J`. Press `Enter`: the palette closes, the URL is unchanged, and nothing errors. Open the palette on Home (`"$URL"`, wait for `New thread`, then `Escape`, `Control+k`) and type the same text: the `Commands` listbox has no option.
- **Binding.** Open `agent-browser --session "$RUN" open "$URL/settings/keyboard"` and `wait --text "Jump to latest event"`. The snapshot shows `Plugin: kitchen-sink`, `Default: Ctrl + Shift + J`, and buttons `Record shortcut for Jump to latest event, current shortcut Ctrl + Shift + J`, `Clear shortcut for Jump to latest event`, and a disabled `Reset shortcut for Jump to latest event` when there is no override. `"$TB" settings keyboard list --json` lists bb's built-in `bindings` and every `overrides` entry, but not a plugin command's default, so the command appears there only once overridden (as `plugin:kitchen-sink/jump-to-latest-event`).
- **Scroll.** On `<ks-long-id>`, read the timeline with `S='(() => { const t = document.querySelector("[data-thread-window] .thread-scrollbar"); return [t.scrollHeight, t.clientHeight, t.scrollTop]; })()'` and `agent-browser --session "$RUN" eval "$S"`: at the tail it reads about `[5480, 1016, 4464]`. Scroll up with the wheel over the timeline: `agent-browser --session "$RUN" mouse move 1000 500`, then `agent-browser --session "$RUN" mouse wheel -1200` five times. `eval "$S"` reads `scrollTop` `0` and the snapshot lists `button "Scroll to latest event"`. Press `Escape`, then `agent-browser --session "$RUN" press Control+Shift+j`. Run `agent-browser --session "$RUN" wait --fn '(() => { const t = document.querySelector("[data-thread-window] .thread-scrollbar"); return t.scrollHeight - t.scrollTop - t.clientHeight < 4; })()' --timeout 5000`: it passes, `scrollTop` is back at `4464`, and `Scroll to latest event` has left the snapshot.
- **Split.** With two long threads side by side, scroll both to the top, focus one pane, and run the command. Only the focused thread's pane reaches its tail; read both panes' `scrollTop` with one `eval` and report both values. <!-- unverified: not driven; needs two long fake-turn threads opened side by side -->
- **Proof.** Capture `agent-browser --session "$RUN" screenshot "$EV/ks-jump-before.png"` and `"$EV/ks-jump-after.png"` around the command, and save each probe's output to `$EV`.
- **Cleanup.** Restore dark media without reduced motion, close the palette, and delete fixtures as the thread-details file does.

## Gotchas

- The fade lasts 180 ms; a screenshot cannot show it. Prove it with the computed-style probe, not by eye.
- The command is hidden on surfaces without a thread, so an absent palette entry on Home or Settings is correct.
- Home autofocuses the composer, and a chord pressed there can type into a draft. Press `Escape` before each shortcut.
- On a thread whose timeline does not overflow, the command does nothing visible. That is not a failure; it is an unmet precondition.
- Setting `scrollTop = 0` from `eval` does not stick: bb's follow-the-tail snaps the timeline back to the bottom. Scroll with `mouse wheel` over the timeline instead.
- `agent-browser eval` runs each script in the page's global scope, so a top-level `const t` fails on the second call with `Identifier 't' has already been declared`. Wrap probes in `(() => { … })()`.
- In a headed Chrome, `Ctrl+Shift+J` may open DevTools before the page sees it. Use the palette path there.
- bb's palette opens with `Mod+K` (mirrored from live's `palette.open` override). Read the current chord from `"$TB" settings keyboard list --json | jq '.overrides[] | select(.command=="palette.open")'`.
- `agent-browser set media dark reduced-motion` keeps dark; plain `set media dark` afterwards turns reduced motion back off.
