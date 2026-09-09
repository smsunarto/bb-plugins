# Feature map

Use one file for the changed user path. Each file defines the user entry, browser actions, proof, and known traps.

## Baseline

The control helper prepares one pinned bb app. It installs every workspace plugin
from this checkout, resets non-secret plugin settings, and selects bb Monokai.
It disables the built-in `inline-vis` in this runtime so Kitchen Sink's message
directive can render.

## Browser conventions

- Use the session and URL from `run.env`.
- Prefer a role and visible name over a CSS selector.
- Wait for the visible result after each route change.
- Save evidence under `$ARTIFACT_DIR`.
- Inspect screenshots before you report success.

## Proof contract

Every run must show the initial state, the user action, and its visible result. Save the final URL when navigation is part of the result.

## Features

- [Agentation feedback](agentation-feedback.md)
- [Canvas file opener](canvas-file-opener.md)
- [GitHub Stack panel](github-stack-panel.md)
- [GTD sidebar](gtd-sidebar.md)
- [Kitchen Sink message embeds](kitchen-sink-embeds.md)
- [Last Turn Diff](last-turn-diff.md)
- [bb Monokai](bb-monokai.md)
- [Vimium link hints](vimium-link-hints.md)
