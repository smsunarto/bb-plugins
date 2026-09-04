# Canvas file opener

## Sub-features

- Canvas registration in the thread file opener.
- Rendering of `.canvas.mdx` files inside the side-panel tab.
- The **Open as canvas** action for other MDX files.
- Interactive controls and rendered document state.
- Comments: a comment button on block hover, thread cards under the block, and `bb canvas comments` for the agent.

## How to get to it (user POV)

Open a repository-backed thread. Show the right panel and open a new tab. Search for a `.canvas.mdx` file and select it.

The result is the rendered Canvas document inside the side-panel tab. A plain MDX file instead offers **Open as canvas**.

## Driving it with agent-browser

The repository includes a representative Canvas file.

```bash
# Select Show right panel only when the panel is closed.
agent-browser --session "$BROWSER_SESSION" find role button click --name "Open new tab (⌘ T)"
agent-browser --session "$BROWSER_SESSION" find role combobox fill --name "Search files (⌘ P)" "flaky-test-triage"
agent-browser --session "$BROWSER_SESSION" find role option click
agent-browser --session "$BROWSER_SESSION" wait --text "Flaky test triage for bb-plugins CI"
agent-browser --session "$BROWSER_SESSION" wait --text "Runs sampled"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Collapse scripts/bb-dev-cli"
```

Capture the file picker, the side panel with the rendered Canvas, and the diff after collapsing it.

### Comments

Hover a block to reveal its comment button, open the composer, and submit. The thread card appears under the block and the CLI lists it.

```bash
agent-browser --session "$BROWSER_SESSION" find text hover "Fourteen suites failed"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Comment on this block"
agent-browser --session "$BROWSER_SESSION" find role textbox fill --name "Add a comment" "Verify this number"
agent-browser --session "$BROWSER_SESSION" find role button click --name "Comment"
agent-browser --session "$BROWSER_SESSION" wait --text "Verify this number"
bb-kit dev-instance exec -- bb canvas comments "$CANVAS_PATH"
bb-kit dev-instance exec -- bb canvas comment "$CANVAS_PATH" "$THREAD_ID" --reply "Checked." --resolve
```

`$CANVAS_PATH` is the absolute path of the opened canvas and `$THREAD_ID` comes from the `comments` output. After the resolve, the card hides and the toolbar shows **Show resolved (1)**. Capture the hover affordance, the open composer, the collapsed card, and the CLI output.

## Gotchas

- The thread must expose repository or thread-storage files.
- Search files is a combobox. Fill it by its `Search files` placeholder; the accessible name only appears once the launcher is open.
- Narrow the search to one result before selecting the option.
- Restore changed controls before cleanup when their state can persist.
- Use `plugins/canvas/examples/flaky-test-triage.canvas.mdx` for the repository fixture.
- Every block has a `Comment on this block` button, so hover the target block first or pick by index. Commenting writes `<canvas>.comments.json` beside the fixture; delete it during cleanup.
