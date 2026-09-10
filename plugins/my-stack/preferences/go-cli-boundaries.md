---
way: my-go-way
description: Scott's preferences when building a Go command-line tool or terminal interface.
---

# Go command boundaries

Prefer Kong for a new Go CLI when the repository leaves the parser choice
open. Keep the command shape easy to browse with declarative command structs
and orchestration in `Run`.

Keep formatting, prompts, and terminal cleanup near the command or UI.
Return plain values and domain errors from lower layers. For Bubble Tea,
prefer a `Run(ctx, ...)` boundary that owns the program and returns a result
without leaking terminal state into the domain.
