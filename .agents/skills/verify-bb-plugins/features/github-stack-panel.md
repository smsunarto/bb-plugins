# GitHub Stack panel

## Sub-features

- GitHub Stack entry in a thread tab.
- Branch stack display for a repository-backed thread.
- Empty and loading states when stack data is unavailable.

## How to get to it (user POV)

Open a thread that belongs to a Git repository. Show the right panel, open a new tab, and select **GitHub Stack**.

The result shows a stack, the current branch, an unstacked composer, or an explicit empty or error state. It must leave loading.

## Driving it with agent-browser

Use visible labels from the current bb tab picker. Take a snapshot first because labels can change with the pinned bb release.

```bash
agent-browser --session "$BROWSER_SESSION" snapshot
# Select Show right panel only when the panel is closed.
agent-browser --session "$BROWSER_SESSION" find role button click --name "Open new tab (⌘ T)"
agent-browser --session "$BROWSER_SESSION" wait 'input[placeholder="Search files"]'
agent-browser --session "$BROWSER_SESSION" find text "GitHub Stack" click
```

Wait for the loading state to disappear. Prove one terminal state:

- The current branch uses the `Current branch` accessible label.
- A stacked branch can show its pull request title. Its branch name can appear in a tooltip.
- An unstacked branch shows `This branch is not part of a stack yet`.
- Empty and error states show `No stack data.` or an explicit error.

## Gotchas

- This feature needs a repository-backed thread.
- Branch names depend on the selected fixture. Record the expected name before driving.
- Search files is a combobox. Do not click its placeholder text.
- A command success does not prove the stack rendered. Capture the panel.
