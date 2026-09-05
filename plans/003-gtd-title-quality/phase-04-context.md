# Phase 4. Build a bounded context candidate

[Plan overview](overview.md) · [Heuristics](heuristics.md)

## Goal

Keep the current subject and phase available within the existing input budget.

## Changes

- Revise candidate context selection in `plugins/gtd-sidebar/lib/thread-naming.ts`.
- Add focused cases in `plugins/gtd-sidebar/test/thread-naming.test.ts`.

Supply the completed handoff on the first turn as well as later turns. Consider the current title, latest substantive request, initial task anchor, and short steering only when they add information. Deduplicate overlapping text and remove redundant boilerplate before raising any cap. Forced generation uses the latest visible user request, even if it is still running. It includes a handoff only when that same request completed. An earlier completed task cannot supply a newer request's progress evidence. The initial request remains an optional subject anchor. Preserve explicit forced naming of archived or hand-named threads.

Build from a coherent completed-turn snapshot. Do not pair a later user request with an earlier unrelated handoff. Supplied current titles are hints, not authority over newer explicit requests. Use deterministic selection first. Do not add a summarization model call to every rename.

## Data structures

`NamingContext` contains the selected request/steering, completed handoff, optional task anchor/current title, and supplied phase evidence. The renderer enforces one total input envelope, not independent ever-growing field caps.

## Verification

Static: first-turn continuation, generic follow-up, substantive task switch, conflicting stale title, and forced-current-task behavior. Give forced behavior its own small verification checkpoint if archived/manual and incomplete-turn coverage exceed five cases.

Runtime: replay the observed Laminar, BB Connect, and Monaco-style failures with the candidate at low effort. Inspect both the injected text and generated title. Record usage against the same-case baseline. Keep this candidate opt-in until phase 8.

Exit: the renderer preserves load-bearing facts without an unmeasured input increase.
