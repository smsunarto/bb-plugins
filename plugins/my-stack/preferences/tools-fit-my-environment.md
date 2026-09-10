---
way: my-tools-way
description: Scott's preferences when choosing local development tools, browser tooling, or where a repository belongs.
---

# Fit Scott's environment

Default to `~/git` for checkouts. Prefer GitButler for version control and
the project's existing tooling. Keep shared machine and agent configuration
in dotfiles. Prefer an existing BB plugin and an SDK capability when extending
BB features.

Prefer an authenticated CLI when it covers a browser task. Use `agent-browser`
for browser work that does not need Scott's logged-in session. Use the
appropriate harness-specific tool for credentials and native desktop
interactions.
