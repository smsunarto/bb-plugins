# NoVNC remote screen

## Sub-features

- Conditional **Show remote screen** composer action.
- Embedded NoVNC viewer and PiP panel state.
- Authentication fallback.
- Hidden action when the NoVNC prerequisite is unavailable.

## How to get to it (user POV)

Open a thread whose environment host runs NoVNC. Select **Show remote screen** in the composer actions.

The result shows the **Remote screen** viewer. Select **Hide remote screen** to close it.

## Prerequisites

The thread needs an environment and enrolled host. That host must expose `/vnc.html` on port 6080 through a bb shared tunnel.

If the action is absent, record the exact missing prerequisite. Do not report the hidden action as a UI failure.

## Driving it with agent-browser

```bash
agent-browser --session "$BROWSER_SESSION" find role button click --name "Show remote screen"
agent-browser --session "$BROWSER_SESSION" wait 'iframe[title="Remote screen"]'
agent-browser --session "$BROWSER_SESSION" screenshot body "$ARTIFACT_DIR/novnc-remote-screen.png"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Hide remote screen"
agent-browser --session "$BROWSER_SESSION" get count 'iframe[title="Remote screen"]'
```

The final iframe count must be zero. An authentication prompt is a valid terminal state when the server requires credentials.

## Gotchas

- The generic fixture does not start NoVNC.
- The action stays hidden for `no-host`, `tunnel-unavailable`, and `not-running` states.
- Test the service on the thread environment host. The bb app host can differ.
- Always hide the viewer before cleanup.
