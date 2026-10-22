---
description: Shared contracts, persisted data, migrations, or downstream consumers may be affected.
---

# Blast radius

What can break beyond the changed lines? Suggestions to investigate:

- Callers, sibling modules, and indirect consumers of changed or deleted behavior.
- JSON responses, database columns, persisted data, wire formats, generated clients, and other languages consuming the same contract.
- Compatibility across deployments, migrations, feature flags, and rollback.
- Library behavior at the pinned version, including local patches.
- When work runs: callbacks, microtasks, unmount, teardown, and asynchronous completion.

Find the one or two facts the change's safety depends on, then trace whether they hold. Listing callers alone does not establish safety. Suggest a focused repro using the real code when supplied evidence cannot establish a critical assumption.

Separate confirmed breakage, risks ruled out, and unproven assumptions. Support each conclusion with pinned source or supplied evidence, and suggest the cheapest check for anything material that remains unverified.
