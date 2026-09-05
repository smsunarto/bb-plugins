# Phase 2b. Record every inference attempt

[Plan overview](overview.md) · [Evaluation protocol](testing.md)

## Goal

Expose the primary and fallback costs without changing the title caller's behavior.

## Changes

- Add an optional typed attempt observer in `plugins/gtd-sidebar/thread-title-inference.ts`.
- Cover it in `plugins/gtd-sidebar/test/thread-title-inference.test.ts`.

Keep the existing title-string result and one authoritative inference path. Report model, effort, usage, monotonic service duration, fallback position, and terminal outcome for every actual attempt. A failed attempt without provider usage has unknown cost. Do not silently omit it from aggregates.

The evaluator supplies the observer. Runtime may supply a lightweight structured logger with prompt capture disabled. This avoids a separate evaluator implementation of retry logic or a breaking return-type change for every existing caller.

## Data structures

`InferenceAttemptMeasurement` contains observed attempt metadata and optional provider usage. The callback only observes data. It cannot mutate a thread or alter the inference decision.

## Verification

Static: primary success, fallback success, two failures, missing usage, and unchanged title/error behavior when no observer is present.

Runtime: force a transient first-attempt failure in the isolated test transport. Confirm the observer receives two attempts, measures the retry separately, and the caller still receives the correct title. Compare a normal request with phase 2's host usage record.

Exit: end-to-end propagation from the stream through the RPC and inference wrapper to evaluation records. Queueing remains a separate runtime measurement in phase 9.
