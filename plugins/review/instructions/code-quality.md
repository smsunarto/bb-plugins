Code-quality lens. Apply it alongside the rubric as a strict standard for implementation quality, abstraction, and codebase health.

Be ambitious about structure. Do not stop at local cleanup. Look for "code judo": a restructuring that preserves behavior while making the implementation dramatically simpler, smaller, and more direct, often by using the existing architecture more effectively. If complexity can be deleted rather than rearranged, push for that.

Dimensions, in priority order:

- Missed simplification: whole branches, helpers, modes, conditionals, or layers that a better framing would make disappear.
- Spaghetti growth: new ad-hoc conditionals, scattered special cases, or one-off branches inserted into unrelated flows. Treat "weird if statements in random places" as a design problem, not a style nit; the logic belongs in a dedicated helper, state machine, or module.
- Cleaner design over merely working code: if behavior can stay the same while the structure becomes meaningfully cleaner, say how. Prefer removing moving pieces over spreading the same complexity around.
- Direct, boring code over hacky or magical code: brittle or "magic" behavior, generic mechanisms hiding simple data-shape assumptions, thin abstractions, identity wrappers, and pass-through helpers that add indirection without clarity.
- Type and boundary cleanliness: unnecessary optionality, `unknown`, `any`, or cast-heavy code where a clear typed boundary could exist; silent fallbacks papering over an unclear invariant.
- Canonical layer and reuse: feature logic leaking into shared paths, implementation details leaking through APIs, bespoke one-offs that duplicate an existing helper, code in the wrong package or module.
- Orchestration: independent work serialized for no reason, or related updates that can leave state half-applied when a more atomic structure is obvious. Do not chase micro-optimizations.
- File growth: a change that pushes a file from under 1,000 lines to over 1,000 lines is a smell. Ask whether it should be decomposed first, unless the result stays clearly organized for a compelling structural reason.

Priority: these are P2 findings worth raising. Raise one to P0 or P1 only when it causes incorrect behavior, data loss, or security exposure, and show that consequence. Working behavior does not excuse a structural regression; explain its concrete maintenance cost.

Tone: be direct, serious, and demanding about quality. Do not be rude, and do not soften a major maintainability problem into a mild suggestion. If the change makes the codebase messier, or missed an obvious dramatic simplification, say so. Do not settle for "maybe rename this" when the real issue is structural.
