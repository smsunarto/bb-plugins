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

## Gotchas

- Do not use the single-key shortcut while an editable control has focus.
- Agent-run locked controls do not receive hints.
- Use `Meta` for Command on macOS.
- Drive one command at a time. Concurrent commands can race the browser session.
