# Canvas file opener

## Sub-features

- Canvas registration in the thread file opener.
- Automatic handoff of `.canvas.mdx` files to the Canvas page in a split pane.
- The **Show here** action that renders the canvas inside the side-panel tab instead.
- The **Open as canvas** action for other MDX files.
- Interactive controls and rendered document state.

## How to get to it (user POV)

Open a repository-backed thread. Show the right panel and open a new tab. Search for a `.canvas.mdx` file and select it.

The result is a new split pane beside the thread showing the rendered Canvas document, with the URL at `/plugins/canvas/canvas/<encoded source>`. The side-panel tab keeps **Open pane** and **Show here** buttons. A plain MDX file instead offers **Open as canvas**.

## Driving it with agent-browser

The repository includes a representative Canvas file.

```bash
# Select Show right panel only when the panel is closed.
agent-browser --session "$BROWSER_SESSION" find role button click --name "Open new tab (⌘ T)"
agent-browser --session "$BROWSER_SESSION" find role combobox fill --name "Search files (⌘ P)" "flaky-test-triage"
agent-browser --session "$BROWSER_SESSION" find role option click
agent-browser --session "$BROWSER_SESSION" wait --url "**/plugins/canvas/canvas/**"
agent-browser --session "$BROWSER_SESSION" wait --text "Flaky test triage for bb-plugins CI"
agent-browser --session "$BROWSER_SESSION" wait --text "Runs sampled"
agent-browser --session "$BROWSER_SESSION" find role checkbox click --name "Show the proposed patch"
```

Capture the file picker, the two-pane layout with the rendered Canvas, and the changed interactive state.

## Gotchas

- The thread must expose repository or thread-storage files.
- Search files is a combobox. Fill it by its `Search files` placeholder; the accessible name only appears once the launcher is open.
- The split hides the thread's side panel, so the **Open pane** stub is not visible after the handoff. Widen the thread pane or close the split to see it.
- Narrow the search to one result before selecting the option.
- Restore changed controls before cleanup when their state can persist.
- Use `plugins/canvas/examples/flaky-test-triage.canvas.mdx` for the repository fixture.
