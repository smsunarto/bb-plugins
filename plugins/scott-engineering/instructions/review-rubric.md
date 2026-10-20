Review rubric. Apply the lenses that fit this change; a small bug fix does not need paragraphs about architecture.

Correctness: does the code do what the summary and brief say it should?

- Edge cases: empty input, null or undefined, boundary values, concurrent access.
- Error handling: are errors caught, propagated, or silently swallowed? Do both the happy path and the failure path work?
- Off-by-one, type coercion, overflow, string encoding.
- State: race conditions, stale closures, dangling references.
- Idempotency: what happens if the operation runs twice, or a previous run crashed halfway? If the answer depends on leftover state, a reconciliation step is missing.
- Concurrency: if several actors can touch the same mutable state (files, branches, shared records), is access serialized structurally (locks, sequential phases, exclusive ownership) or by conventions that will not hold?

When you find a potential bug, trace the execution path. Do not just say "this could be null"; show the call chain that makes it null.

Root causes vs. symptoms: is the change fixing the actual problem or papering over it? Read beyond the changed lines: callers, callees, type definitions, and sibling modules in the pinned tree and files through scott_engineering_review_context. Understand why the code exists before judging whether the change addresses the right layer.

- Guard clauses that mask a deeper invariant violation.
- Retries that hide a broken contract.
- Casts that silence a modeling error.
- Workarounds: why is it needed, and what would the proper fix look like?
- A fix in module A that belongs in module B's contract.
- A comment or convention saying "don't do X" where a type constraint, lint rule, or runtime check could make the wrong thing impossible.

Structural integrity: does the change fit the system it lives in?

- Boundary discipline: validate data once where it enters the system, then trust it internally; flag validation scattered through business logic.
- Abstraction level: high-level orchestration mixed with low-level detail.
- Coupling: new dependencies that make future changes harder.
- Data model fit: structures that do not match the actual access patterns.
- Bolted-on vs. integrated: if this requirement had been known from the start, would the code look like this?
- Legacy dual paths: a new API added while the old one stays alive with no external consumers. Callers should migrate and the old path should go in the same change.

Do not penalize simple code for lacking abstraction. Premature abstraction is worse than duplication.

Verification: can you tell from the diff and supplied evidence that this works? You cannot run tests, so judge coverage by reading them.

- Are there tests, and do they test behavior rather than implementation details?
- Is there a regression test for a bug fix? Is an integration boundary tested end to end?
- Does the code check the real thing rather than a proxy, such as cached state or file mtime instead of the actual value?
- For delegated or async work, does the code verify actual output artifacts, or trust self-reports?

Claims about test results that the evidence does not establish belong in limitations, not findings or coverage.

Complexity budget: is the complexity justified by what the code accomplishes?

- Code that could be simpler without losing correctness.
- Abstractions with one call site; configuration for cases that do not exist yet.
- Dead code, unused imports, vestigial parameters, "just in case" paths with no callers.
- Compatibility scaffolding kept after its migration finished.
- Features, controls, or options that do not earn their place. Half-finished features are worse than missing ones.

Simpler is better unless simpler is wrong.

Security: for each security finding, trace the input path through the code and show it.

- User input reaching dangerous sinks (SQL, shell, eval, innerHTML) without sanitization.
- Authentication or authorization gaps in new endpoints.
- Secrets in code, logs, or error messages.
- Time-of-check to time-of-use gaps in security-critical paths.
