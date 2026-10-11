---
name: review-standard
description: Request a standard independent review of a design or implementation.
disable-model-invocation: true
argument-hint: "[branch, plan, or review focus]"
---

The user requested a **standard** review. Use `review_start` with `mode: "standard"`; do not silently change the requested mode. These slash commands are user-only. Agents use the native review tools directly when review is warranted.

Infer the intended design or implementation and workstream from the user's arguments and conversation. Start with a short summary. Additional context can be supplied as an optional brief or evidence references; do not require a long report.

For implementation review, select the intended GitButler branch checkpoint or explicit base/head revisions. Never select `HEAD`, `gitbutler/workspace`, all applied branches, or all uncommitted changes. If the intended branch is ambiguous, ask which workstream to review. Checkpoint only this workstream's selected changes if needed; preserve other agents' work.

For design review, use `kind: "design"`, summarize the proposed choice and constraints, and optionally identify pinned repository context. Focus on consequential assumptions, tradeoffs, dependencies, and cheap validation before expensive implementation.

Prefer `reuse: "auto"` for the same workstream. Use `review_result` with the returned run ID. Report verified findings and unresolved risks; do not claim that a partial or failed review cleared the candidate. Fix valid findings when the user's request authorizes fixes; otherwise report them without changing the work.

For shipping or opening/updating a PR, request a **Deep implementation** run with `scope: "publication"` (`--scope publication` in the CLI). Branch publication scope pins merge-base to that branch tip, including its ancestor stack segments and excluding other applied stacks. Explicit base/head must cover the complete publication delta. Outside GitButler, declare target.upstream (--upstream origin/main); base must be the merge base with that destination. Deep follow-ups can reuse an eligible idle reviewer at maximum effort; each run must read and assess its own pinned candidate. Use reuse:new for fresh judgment. The result gate requires a current candidate, matching execution, every diff page served to the reviewer, complete output, and no P0/P1 findings.
