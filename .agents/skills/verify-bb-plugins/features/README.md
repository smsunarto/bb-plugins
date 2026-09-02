# Feature map

Use one file for the changed user path. Each file defines the user entry, browser actions, proof, and known traps.

## Baseline

The control helper prepares one pinned bb app. It installs every workspace plugin from this checkout. It also resets plugin settings and selects bb Monokai.

## Browser conventions

- Use the session and URL from `run.env`.
- Prefer a role and visible name over a CSS selector.
- Wait for the visible result after each route change.
- Save evidence under `$ARTIFACT_DIR`.
- Inspect screenshots before you report success.

## Proof contract

Every run must show the initial state, the user action, and its visible result. Save the final URL when navigation is part of the result.

## Features

- [Agent Proxy navigation](agent-proxy-navigation.md)
- [Agentation feedback](agentation-feedback.md)
- [GitHub Stack panel](github-stack-panel.md)
- [GTD sidebar](gtd-sidebar.md)
- [bb Monokai](bb-monokai.md)
