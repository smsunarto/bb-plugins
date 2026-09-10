# Canvas files in Docs

## Sub-features

- Docs registration for `.md`, `.mdx`, and `.canvas.mdx` file tabs.
- Rendering of `.canvas.mdx` files inside the side-panel tab.
- Rich text and source modes for Markdown, MDX, and Canvas files.
- Interactive controls and rendered document state.
- Comments: block selection below the editor, existing thread cards, and `bb canvas comments` for the agent.

## How to get to it (user POV)

Open a repository-backed thread. Show the right panel and open a new tab. Search for a `.canvas.mdx` file and select it.

The result is a Docs editor with rendered Canvas widgets. Plain MDX and Markdown files use the same toolbar and source-mode controls.

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

Scroll below the editor to Canvas comments. Expand **Add a comment**, choose a
block from **Comment on**, fill the textbox, and submit **Comment**. Confirm the
thread appears and `"$BB_CLI" canvas comments "$CANVAS_PATH"` lists it. Reply and
resolve from either the UI or CLI, then confirm the resolved toggle updates.

`$CANVAS_PATH` is the absolute path of the opened canvas and `$COMMENT_THREAD_ID`
is the `cmt_...` ID from the `comments` output. `BB_CLI` comes from this run's
`run.env`. After the resolve, the card hides and the toolbar shows
**Show resolved (1)**. Capture the block selector, the open composer, the
collapsed card, and the CLI output.

## Gotchas

- The thread must expose repository or thread-storage files.
- Search files is a combobox. Fill it by its `Search files` placeholder; the accessible name only appears once the launcher is open.
- Narrow the search to one result before selecting the option.
- Restore changed controls before cleanup when their state can persist.
- Use `plugins/canvas/examples/flaky-test-triage.canvas.mdx` for the repository fixture.
- Use the comment section below MDXEditor. Select the intended block by its visible label.
- Commenting writes `<canvas>.comments.json` beside the file. Use a copy under this run's scratch directory for comment tests. Open it with `"$BB_CLI" thread open <bb-thread-id> "$CANVAS_PATH"`. Remove only sidecars this run created.
