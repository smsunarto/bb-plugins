# GTD sidebar

## Sub-features

- GTD Sidebar choice in Appearance settings.
- Inbox, Next Action, and Waiting sections.
- Most recently updated threads first in every section.

## How to get to it (user POV)

Open **Settings**, then **Appearance**. Open **Sidebar thread list**. Select **GTD Sidebar**.

Return to the main surface. The sidebar groups threads under the GTD sections.

## Driving it with agent-browser

```bash
agent-browser --session "$BROWSER_SESSION" find role link click --name "Settings (⌘ ,)"
agent-browser --session "$BROWSER_SESSION" find role link click --name "Appearance"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Sidebar thread list"
agent-browser --session "$BROWSER_SESSION" find role menuitem click --name "GTD Sidebar (inbox) Next Action and Waiting, with recent threads first."
```

Capture the selected setting. Then return to the main surface and capture the grouped sidebar.

## Gotchas

- Selecting the option changes the pinned test instance.
- `launch` resets plugin settings before the next run.
- Empty sections depend on fixture threads. Prove grouping with a fixture that covers the expected sections.
