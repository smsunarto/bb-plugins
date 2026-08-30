# GitHub Stack panel

## Sub-features

- GitHub Stack entry in a thread tab.
- Branch stack display for a repository-backed thread.
- Empty and loading states when stack data is unavailable.

## How to get to it (user POV)

Open a thread that belongs to a Git repository. Open a new tab. Search files, then select **GitHub Stack**.

The result shows the current branch or an explicit empty state. It must not stay on a loading state.

## Driving it with agent-browser

Use visible labels from the current bb tab picker. Take a snapshot first because labels can change with the pinned bb release.

```bash
agent-browser --session "$BROWSER_SESSION" snapshot
agent-browser --session "$BROWSER_SESSION" find text "Open new tab" click
agent-browser --session "$BROWSER_SESSION" find text "Search files" click
agent-browser --session "$BROWSER_SESSION" find text "GitHub Stack" click
```

Wait for the expected branch name when the fixture defines one. Otherwise, assert the explicit empty state and save it.

## Gotchas

- This feature needs a repository-backed thread.
- Branch names depend on the selected fixture. Record the expected name before driving.
- A command success does not prove the stack rendered. Capture the panel.
