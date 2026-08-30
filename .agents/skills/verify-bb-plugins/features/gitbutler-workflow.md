# GitButler workflow panel

## Sub-features

- GitButler entry in a thread panel.
- Multiple applied stacks and their branches remain visible.
- Native BB file links and one native diff per selectable hunk.
- Explicit existing or new target branch with a required commit message.
- Stale, rejected, and uncertain commit results remain visible.

## How to get to it (user POV)

Open a repository-backed thread whose environment is the primary checkout. Open a new tab, then select **GitButler**.

The result shows every applied GitButler stack and the current worktree. Select one disposable hunk, choose a target branch, enter a message, then select **Commit 1 selected hunk**.

## Driving it with agent-browser

Take a snapshot first because the pinned BB tab picker can change labels.

```bash
agent-browser --session "$BROWSER_SESSION" snapshot
agent-browser --session "$BROWSER_SESSION" find text "Open new tab" click
agent-browser --session "$BROWSER_SESSION" find text "GitButler" click
agent-browser --session "$BROWSER_SESSION" wait --text "Applied stacks"
```

Capture the rendered stacks and native diff before mutation. Use only a disposable fixture hunk. Capture the visible committed, rejected, or uncertain result and the refreshed worktree.

## Gotchas

- The environment must be ready, Git-backed, and not a linked worktree.
- The first release supports `but 0.22.3` exactly.
- A commit mutates the fixture repository. Use a disposable branch and hunk.
- An uncertain result may have committed. Refresh before any second attempt.
