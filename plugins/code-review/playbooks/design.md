---
description: Ownership, APIs, data models, dependencies, implementation complexity, or design proposals.
---

# Design and code quality

Does the change fit its system, and can a better structure remove complexity? For proposals, trace ownership and control flow through concrete callers and failure scenarios. For code, consider:

- Domain models that match access patterns and make invalid states hard to represent.
- Validation at boundaries, clear typed contracts, and high-level orchestration separated from low-level details.
- Responsibility in the canonical module, reuse of existing helpers, and dependencies that will constrain later changes.
- Legacy dual paths, compatibility scaffolding, dead code, unused parameters, and speculative configuration after migration.
- Ad-hoc conditionals or scattered special cases that a state machine, helper, or better data shape could eliminate.
- Thin wrappers, identity helpers, generic mechanisms hiding simple assumptions, and unnecessary layers.
- Optionality, `unknown`, `any`, casts, and silent fallbacks that conceal unclear invariants.
- Independent work serialized unnecessarily, or related updates that can leave state half-applied.
- File growth that obscures responsibilities. Crossing 1,000 lines can prompt a closer look; size alone does not establish a defect.

Look for "code judo": a restructuring that preserves behavior while making the implementation dramatically simpler, smaller, and more direct. Prefer deleting moving parts over rearranging them. Simple code need not acquire an abstraction merely to satisfy a pattern.

Explain the concrete maintenance cost and a feasible simpler structure. Structural problems can warrant P2 findings even when behavior works; higher severity needs a demonstrated correctness, data-loss, or security consequence.
