# Bug fix

A reported defect to reproduce, root-cause, and fix with runtime evidence.

Aim for every shipped line to trace back to evidence. A change that "might help" is a hypothesis, not a fix, and when evidence refutes it, revert what it motivated.

What tends to work:

1. Reproduce it yourself on the surface where it shows up, with the matching control tool (`agent-browser`, `control-cli`, a test runner). If it won't reproduce directly, synthesize the trigger, tighten conditions, or add instrumentation until it fires. Ask the user to reproduce only when you can't reach the surface, and say why.
2. Narrow the cause by elimination. List candidate hypotheses, test the split that rules out the most, and get runtime evidence at each step. When program state is unclear, add logging and read it as the code runs instead of guessing. For a regression, `git log` and blame narrow the window.
3. Fix it at the first place the system went wrong (`fix-root-causes`). If two fixes on one premise have failed, test the premise itself (`attack-the-premise`).
4. Verify on the same surface: the original repro now passes. Unit tests show branch behavior, not that the bug is gone.
5. When a cheap local test exists, land the failing test before the fix (the `tdd` skill, `sequence-verifiable-units`). Skip it when the test would be expensive, integration-heavy, or unclear.

A good reply covers what was broken, the root cause, the fix, and how you verified it, with the failing and then passing output.
