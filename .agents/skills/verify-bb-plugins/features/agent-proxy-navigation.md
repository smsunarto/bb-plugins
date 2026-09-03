# Agent Proxy navigation

## Sub-features

- Sidebar registration for Agent Proxy.
- Navigation between Home, OAuth, Providers, Usage, Agents, and Advanced.
- Agent configuration guidance on the Agents page.

## How to get to it (user POV)

Open bb. Select **Agent Proxy** in the left sidebar. Visit Home, OAuth, Providers, Usage, Agents, and Advanced.

Each page shows its own content. The URL ends with the selected page name.

## Driving it with agent-browser

```bash
agent-browser --session "$BROWSER_SESSION" set viewport 1728 1117 2
agent-browser --session "$BROWSER_SESSION" open "$BB_APP_URL"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Agent Proxy"
agent-browser --session "$BROWSER_SESSION" wait --text "CLIProxyAPI core"
agent-browser --session "$BROWSER_SESSION" find role button click --name "OAuth"
agent-browser --session "$BROWSER_SESSION" wait --text "Authorized accounts"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Providers"
agent-browser --session "$BROWSER_SESSION" wait --text "Proxy access keys"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Usage"
agent-browser --session "$BROWSER_SESSION" wait --text "Recent activity"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Agents"
agent-browser --session "$BROWSER_SESSION" wait --text "Anything OpenAI-compatible"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Advanced"
agent-browser --session "$BROWSER_SESSION" wait --text "Service"
```

Capture Home and the final page. Save the final URL. Its suffix must match the selected page.

## Gotchas

- The first Agent Proxy button is the sidebar entry. Run the commands in order.
- Do not assert provider data unless the test set that data.
- Treat the visible heading and URL together as navigation proof.
