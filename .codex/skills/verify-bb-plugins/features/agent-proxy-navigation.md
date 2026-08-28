# Agent Proxy navigation

## Sub-features

- Sidebar registration for Agent Proxy.
- Navigation between Home, OAuth, Providers, Usage, Agents, and Advanced.
- Agent configuration guidance on the Agents page.

## How to get to it (user POV)

Open bb. Select **Agent Proxy** in the left sidebar. Select **Agents** in the plugin navigation.

The result shows `Anything OpenAI-compatible`. The URL ends with `/plugins/agent-proxy/agent-proxy/agents`.

## Driving it with agent-browser

```bash
agent-browser --session "$BROWSER_SESSION" open "$BB_APP_URL"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Agent Proxy"
agent-browser --session "$BROWSER_SESSION" wait --text "CLIProxyAPI core"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Agents"
agent-browser --session "$BROWSER_SESSION" wait --text "Anything OpenAI-compatible"
```

Capture one screenshot before selecting Agents. Capture the result after the text appears. Save the final URL.

## Gotchas

- The first Agent Proxy button is the sidebar entry. Run the commands in order.
- Do not assert provider data unless the test set that data.
- Treat the visible heading and URL together as navigation proof.
