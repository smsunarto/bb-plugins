# Vimium

Vimium-style link hints for keyboard navigation of the bb UI.

## What it does

- Press `f` anywhere outside a text field. Every clickable element on screen gets a small yellow hint label. `f` is the bb command Show hints: bind it as shown under Direct keys, or to any key in Settings → Keyboard. `Cmd+Shift+F` stays Vimium's own key, because bb runs commands after the page's own key listeners and Agentation claims the same chord there first.
- Native input autofocus is preserved. Press `i`, click the composer, or Tab to it to focus it manually.
- Press `Cmd+Shift+F` anywhere, including bb's composer. `Escape` also leaves the composer. Press plain `f` for hints; `Escape` then `;` changes speed.
- Type a label's letters to click that element. Already-typed letters dim, and non-matching labels disappear.
- `Backspace` drops the last typed letter. `Escape`, any other key, scrolling, or resizing exits hint mode. In the model and project pickers, `Escape` also closes the picker.
- A hint on a text field focuses it instead of clicking, so `f` can drop you straight into typing.
- Project, machine, and model pickers open without option hints, leaving native search and navigation available. After selecting a model, reasoning choices get number hints in displayed order: `1` Low, `2` Medium, `3` High, and so on when those levels are available. Selecting a reasoning level keeps its number hints available while the popup stays open. Other dropdowns re-prompt automatically: permission modes start at `a`, `s`, `d`, `f`, `g`, and `h`; other choices start at `f`, `j`, `d`, and `k`.
- `Cmd+Shift+F` always means the whole screen. During a scoped prompt it replaces it, and over an open dropdown or dialog it closes the popup first, since an open popup hides the rest of the page from hinting.
- Picking from one of the composer's own dropdowns hands focus back to the composer once the popup closes, so you can keep typing.
- The conversation timeline never gets hints. It rerenders and auto-scrolls while an agent streams, and its own scrolling never dismisses a prompt — only a scroll that moves a hinted element does.

## Direct keys

Outside a text field, single keys act without a hint prompt. Every one except scrolling is a bb command named under Vimium in Settings → Keyboard and the Quick palette, so you rebind, clear, or run them there. bb accepts single-key plugin shortcuts only as user bindings, never as plugin defaults, so the commands ship unbound. Bind them once:

```sh
bb settings keyboard set plugin:vimium/show-hints f
bb settings keyboard set plugin:vimium/new-thread n
bb settings keyboard set plugin:vimium/home h
bb settings keyboard set plugin:vimium/search-threads s
bb settings keyboard set plugin:vimium/settings ,
bb settings keyboard set plugin:vimium/next-thread ]
bb settings keyboard set plugin:vimium/previous-thread [
bb settings keyboard set plugin:vimium/settle-thread e
bb settings keyboard set plugin:vimium/undo-archive Shift+E
bb settings keyboard set plugin:vimium/cheatsheet Shift+/
bb settings keyboard set plugin:vimium/focus-composer i
bb settings keyboard set plugin:vimium/model m
bb settings keyboard set plugin:vimium/project p
bb settings keyboard set plugin:vimium/machine l
bb settings keyboard set plugin:vimium/branch b
bb settings keyboard set plugin:vimium/permission-mode a
```

- `n` new thread, `h` Home, `s` thread search, `,` Settings.
- `m` model, `p` project, `l` machine, `b` branch. Each opens its picker, exactly as `f` then the same key would. Only branch options get immediate hints.
- `a` permission mode, as in allow. Its hint label stays `k`, because `k` as a direct key scrolls up.
- `]` next thread and `[` previous thread, stepping through the sidebar's rows in list order, including rows BB has temporarily unmounted while virtualizing a long list. Rows the sidebar keeps in its More popover are skipped, as BB's own previous/next commands skip them. The list wraps. Off any thread, `]` starts at the top and `[` at the bottom.
- `e` settles the focused thread, including a child in a split pane. This needs a sidebar with a settle button on each row, such as gtd-sidebar. If the focused split thread's row is collapsed, expand it before settling.
- `E` (Shift+e) undoes the newest archive notification while it is visible and opens the restored thread. Clicking that notification's Undo button also opens the thread.
- `i` focuses the composer.
- `?` opens the Vimium Cheatsheet page, which lists every key with the binding bb actually uses.

bb gives plugin commands no text-field guard of their own, so Vimium turns down a command whose key arrives from a text field without Ctrl, Cmd, or Alt; inside one, every bare key is just typing. A binding with Ctrl, Cmd, or Alt runs from the composer too. An open project, machine, or model picker keeps every key for its search. bb skips held-key repeats for commands.

These stay Vimium's own keys rather than bb commands:

- `j` scrolls the conversation down one step, `k` scrolls it up, and `J` (Shift+j) jumps to the bottom. They stay out of bb's keybindings because bb drops repeated keydowns, and a held key must keep scrolling. A step is 60px. The scroll animates the way Vimium's does. A tap moves one step in about 100ms, a held key keeps scrolling until you release it, and quick taps add up. `j` and `k` send bb a wheel nudge first, so a streaming reply stops snapping the view back to the bottom until `J` or a scroll to the end re-attaches it. On a page without a conversation they fall through to bb.
- `Escape` then `m` toggles Claude/Codex, pairing Astra ↔ Fable and Sol ↔ Opus. Other models use the destination provider's default. Reasoning and speed are preserved when supported; BB reconciles unsupported values. In an existing thread, this prepares BB's normal provider handoff for the next send.
- `Escape` then `r` cycles the current model's reasoning levels forward and wraps.
- `Escape` then `;` cycles Normal → Fast → Ultrafast → Normal, skipping speeds the model does not offer.
- `Escape` then `a` opens Agentation feedback mode when its sidebar footer button is available. `Escape` alone exits feedback mode.
- These sequences work from the composer too. Press the key within 1.5 seconds of Escape; an unrelated key, click, or window blur cancels the prefix. bb has no two-key sequence bindings, so they stay here.

In hint mode `[`, `]`, `e`, `j`, `k`, and `a` keep their hint meanings below.

`n` and `s` use BB's accessible button names and list-row ids. When New thread has no label, `n` matches its text inside the sidebar header. Home works with the navigation rail; More works with both navigation layouts; Settings works with both rail buttons and list links. `s` activates BB's visible Search threads button when there is one. With a custom sidebar such as GTD that omits it, Vimium opens the Quick palette using `Cmd+K` on Mac or `Ctrl+K` elsewhere, then selects Search threads. That bridge depends on the palette shortcut and action label. If either changes, update the bridge. In hint mode, `f` only labels a visible Search threads button.

## BB shortcuts

bb's own shortcuts all use a modifier, and the single-key bindings above use none, so the two never collide. `Cmd+F` (BB's find in window) is not `Cmd+Shift+F`, and hint mode exits and passes it to BB. BB already binds split focus and panel tabs (Settings → Keyboard), so Vimium adds no single keys for them.

## Labels

- bb's stable controls keep pinned single-character labels for muscle memory: `p` project, `i` composer input, `l` machine, `b` branch, `n` new thread, `s` thread search, `k` permission mode, `j` send, `m` model, `a` prompt actions, and `v` voice.
- Core navigation is stable too: `[` back, `]` forward, `h` Home, `e` the navigation rail’s More menu (including Plugins), `,` Settings, `q` left sidebar, and `\` right sidebar. The context-window tracker is never selectable.
- Sidebar thread rows (bb's own or any sidebar honoring the thread-shortcut contract) count `1`-`0` across the number row.
- Everything else gets two-character labels from the remaining alphabet, extended past the reserved carve-outs so even a diff-heavy screen stays at two characters.

The plugin ships `f` hint mode, the bb commands above, and `j`, `k`, and `J` for conversation scrolling. It does not add search.
