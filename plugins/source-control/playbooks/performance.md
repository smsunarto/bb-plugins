---
description: Hot paths, resource use, scaling, or speedup claims are involved.
---

# Performance

What work grows or becomes more expensive, and does a claimed improvement help the user? Suggestions to investigate:

- Hot paths, repeated renders, allocations, serialization, queries, network calls, and resource cleanup.
- Work scaling with realistic data size or concurrency; unbounded collections, queues, and caches.
- The actual limiter: CPU, I/O, database work, contention, or the load generator itself.
- Whether both sides of a comparison use production-equivalent settings, versions, data, and cache conditions.
- Whether work completes inside the timed region and produces correct output. Fast failures, no-ops, and unawaited work can look like speedups.
- Repeatability, run-to-run variation, warmup, measurement overhead, and physical limits on a plausible gain.
- The changed operation's share of the end-to-end path a user waits for.

Trace a cost to the changed execution path. Distinguish supplied measurements from source-based risks and identify missing measurements. For supplied measurements, report units, run count, range, errors, and the limiter; use "inconclusive" when they cannot support the comparison.
