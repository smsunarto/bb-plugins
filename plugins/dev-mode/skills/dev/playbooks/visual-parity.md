# Visual parity

Pixel-exact UI equivalence, when matching two implementations or migrating a styling system. The baseline is the spec, and equivalence is checked by image diff rather than by eye.

What tends to work:

1. Build the baseline before any migration: a visual regression harness that screenshots the current component across its states, plus the target when matching two implementations. Without a baseline, there's no parity claim to make.
2. Leave the harness and baseline alone, and don't restructure a component just to make a diff pass. If the baseline looks wrong, ask rather than editing it.
3. Migrate one component at a time. Shared primitives go first. Separate components can proceed in parallel, one owner and worktree each (`separate-before-serializing-shared-state`).
4. Diff each component against its baseline on the matching surface. A nonzero diff is a fail worth investigating pixel by pixel; repeat until it reaches zero.

A good reply lists the components migrated, the diff result for each, the harness location, and what's left.
