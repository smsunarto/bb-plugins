---
description: State, concurrency, retries, error handling, or regression coverage changes.
---

# Correctness

Does the change do what its intent says, including failure paths? Suggestions to investigate:

- Empty input, null or undefined, boundary values, type coercion, overflow, and string encoding.
- Errors caught, propagated, or silently swallowed; cleanup after partial failure.
- Races, stale closures, dangling references, and concurrent access to shared mutable state.
- Retries, duplicate operations, and crashes halfway through a lifecycle. Does the next attempt reconcile leftover state?
- Regression coverage for the changed behavior and integration boundaries. Do tests assert observable outcomes rather than implementation details?
- Verification of actual output artifacts for delegated or asynchronous work, rather than trusting self-reports, cached state, or file timestamps.

Trace a suspected bug through callers and callees to a reachable failure. A possible null value alone does not establish a finding.

Check whether a fix addresses the first broken invariant. Guards, retries, casts, and fallbacks can conceal a contract that belongs elsewhere. A type constraint, state model, or boundary may remove the failure path entirely.

Read test assertions to assess coverage. Distinguish supplied test results from behavior the pinned source establishes, and report the remaining verification gap.
