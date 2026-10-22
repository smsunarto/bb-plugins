# Feature

New or changed behavior. The principles here shape the code; visual, UI, and product choices follow the user's direction or the design.

What tends to work:

1. Learn the affected subsystem first: entry points, data flow, existing patterns, and tests.
2. Name the data shape before writing logic, and pick the structure that organizes it (`foundational-thinking`, `model-the-domain`): a state machine over scattered booleans, a table over branching, a typed model over repeated shape assumptions. When the requirement doesn't fit the current design, see `redesign-from-first-principles`.
3. For a decision without precedent in the codebase, sketch two or three designs and compare them before committing (`exhaust-the-design-space`).
4. Sequence the work: what blocks everything else, what can proceed independently, and what shared state parallel workers would write (`separate-before-serializing-shared-state`). Code-coupled work usually goes best with one owner.
5. Build in small, verified units and commit as you go (`sequence-verifiable-units`). Remove dead weight before adding (`subtract-before-you-add`). When you improve a shared primitive, carry the change to every consumer and check each one.
6. Verify on the matching surface (`prove-it-works`). When other consumers might be affected, the `blast-radius` skill maps who.
7. Review the change at handoff with the `review` skill.

A good reply covers what you built and for whom, what you chose and why, and open decisions, with a table when comparing design alternatives.
