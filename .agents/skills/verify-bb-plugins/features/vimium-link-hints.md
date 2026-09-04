# Vimium link hints

## Sub-features

- Global link-hint activation.
- Keyboard selection of visible targets.
- Escape cancellation and marker cleanup.
- The pinned comma hint for Settings.

## How to get to it (user POV)

Open any bb route. Press **Command+Shift+F**. Press the shown hint keys to select a target, or press **Escape** to cancel.

Outside editable controls, the single-key **F** shortcut also starts link hints.

## Driving it with agent-browser

The comma hint is stable because Vimium reserves it for Settings.

```bash
agent-browser --session "$BROWSER_SESSION" press "Meta+Shift+f"
agent-browser --session "$BROWSER_SESSION" wait '.vimium-hint-layer'
agent-browser --session "$BROWSER_SESSION" get count '.vimium-hint-marker'
agent-browser --session "$BROWSER_SESSION" screenshot body "$ARTIFACT_DIR/vimium-hints.png"
agent-browser --session "$BROWSER_SESSION" press ","
agent-browser --session "$BROWSER_SESSION" wait --url "**/settings"
agent-browser --session "$BROWSER_SESSION" press "Meta+Shift+f"
agent-browser --session "$BROWSER_SESSION" press Escape
agent-browser --session "$BROWSER_SESSION" get count '.vimium-hint-marker'
```

The first marker count must be greater than zero. The final count must be zero.

### Direct keys

Outside editable controls, single keys act without a prompt. Press `,` on a thread route to open Settings, `m` to open the model dropdown with a scoped prompt, and `]` or `[` to move to the next or previous sidebar thread.

```bash
agent-browser --session "$BROWSER_SESSION" press Escape
agent-browser --session "$BROWSER_SESSION" press "m"
agent-browser --session "$BROWSER_SESSION" wait '.vimium-hint-layer'
agent-browser --session "$BROWSER_SESSION" screenshot body "$ARTIFACT_DIR/vimium-direct-m.png"
agent-browser --session "$BROWSER_SESSION" press Escape
agent-browser --session "$BROWSER_SESSION" press "]"
agent-browser --session "$BROWSER_SESSION" get url
```

The `m` press must show scoped markers over the model dialog. The `]` press must change the thread id in the URL when the sidebar lists more than one thread.

## Gotchas

- Do not use the single-key shortcut while an editable control has focus.
- Agent-run locked controls do not receive hints.
- Use `Meta` for Command on macOS.
- Drive one command at a time. Concurrent commands can race the browser session.

### Conversation scroll keys

On a thread route with enough rows to scroll, `k` moves the conversation up one 60px step, `j` moves it down, and `J` jumps to the bottom. Read the scroller's `scrollTop` between presses. The scroller is the nearest `overflow-y: auto` ancestor of `[data-timeline-row-list="top-level"]`.

```bash
agent-browser --session "$BROWSER_SESSION" press k
agent-browser --session "$BROWSER_SESSION" press j
agent-browser --session "$BROWSER_SESSION" press J
```

`k` must lower `scrollTop` by 60 and must not open the permission-mode menu. `J` must land on `scrollHeight - clientHeight`. Inside the composer, `j` and `k` must type and leave `scrollTop` alone.
