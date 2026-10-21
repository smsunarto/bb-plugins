---
name: dev
description: Index of engineering principles and suggested playbooks for software engineering work, such as bug fixes, features, refactors, perf work, and investigations. Read it before software engineering work or on /dev. Not for visual, UI, product, or game design decisions.
---

# Dev

Use this for software engineering work: writing, debugging, reviewing, refactoring, or optimizing code, and the architecture, tests, and tooling around it. The principles shape how software is built. Visual, UI, UX, product, and game design choices are not engineering decisions, so leave the principles out of them and follow the user's direction and any design skill. When a task mixes both, such as building a designed screen, apply the principles to the code and leave the design choices to the design.

These are recommendations, not rules. Session, user, and repository instructions come first. Take what fits the task, skip what doesn't, and mention a departure only when the reason is worth knowing.

Adapted from [poteto-mode](https://github.com/cursor/plugins/blob/88d47514b82e7c44f00f2b2a72ff6dd12158038c/pstack/skills/poteto-mode/SKILL.md).

## Principles

Read one with `bb dev-mode principle --name <name>` when its situation comes up. Omit `--name` to list them.

**Core**

- `grug-brain`. Designing, implementing, debugging, or refactoring. Judge simplicity by maintainer effort, dependencies, and obscurity. Prefer deletion and the smallest change that fixes the responsible boundary.
- `foundational-thinking`. Before writing logic: core types and data structures, scaffold-versus-feature sequencing, what concurrent actors share.
- `redesign-from-first-principles`. A new requirement that doesn't fit the current design. Redesign as if it had been there from day one.
- `attack-the-premise`. Two fixes that share one premise have failed the same check. Test the premise before writing a third.
- `subtract-before-you-add`. Sequencing an addition, refactor, or rewrite. Remove dead weight first.
- `minimize-reader-load`. Code that is hard to trace. Count layers and hidden state, collapse one-caller wrappers, shrink mutable scope.
- `outcome-oriented-execution`. Planned rewrites and migrations. Converge on the target instead of preserving throwaway compatibility states.
- `experience-first`. An engineering tradeoff that changes what end users, API callers, or the next maintainer get. Favor their experience over implementation convenience.
- `exhaust-the-design-space`. An architectural, API, or system-design decision with no precedent. Sketch two or three designs and compare them before committing.
- `build-the-lever`. Non-trivial work. Build the tool that does or proves it (codemod, script, generator) instead of doing it by hand.

**Architecture**

- `model-the-domain`. Stateful logic, heavy branching, or one shape assumption repeated across files. Encode it in a structure: a state machine, typed model, table, reducer, or boundary.
- `boundary-discipline`. Validation, error handling, or framework adapters. Guard at system boundaries, trust internal types, keep business logic pure.
- `type-system-discipline`. Designing types or signatures. Make illegal states unrepresentable, brand primitives, parse external data at boundaries.
- `make-operations-idempotent`. Commands, lifecycle steps, or loops that run amid crashes and retries. Converge to the same end state.
- `migrate-callers-then-delete-legacy-apis`. A new internal API while old callers exist. Migrate and delete in one wave.
- `separate-before-serializing-shared-state`. Concurrent actors that might write the same file, branch, key, or object. Remove the sharing first.

**Verification**

- `fix-root-causes`. Debugging. Trace the symptom to the first place the system went wrong and fix it there. A guard is a fix only when the state it handles is legitimate.
- `prove-it-works`. Before calling work done. Check the real artifact, not a proxy, a self-report, or "it compiles".
- `explain-the-number`. Before trusting or reporting a measured number. Name what limits it and rule out that it measured something else.
- `sequence-verifiable-units`. Multi-step work and commit or PR stacking. Small units, each ending in a check, ordered so the sequence proves itself.
- `test-behavior-not-implementation`. Writing or keeping a test. Assert what users observe, so the test fails when behavior breaks and passes when only internals change.

**Meta**

- `encode-lessons-in-structure`. Writing the same instruction a second time. Make it a lint, flag, runtime check, or script instead.

## Playbooks

Suggested approaches for common kinds of work. Open the one that matches and adapt it to the task.

- [Investigation](playbooks/investigation.md). A read-only question: how X works, why Y was built this way, whether Z holds, or which of two approaches to take.
- [Bug fix](playbooks/bug-fix.md). A reported defect to reproduce, root-cause, and fix.
- [Perf issue](playbooks/perf-issue.md). A measured slowness to trace and improve against a baseline.
- [Hillclimb](playbooks/hillclimb.md). Sustained improvement of one metric against a target, one measured attempt at a time.
- [Runtime forensics](playbooks/runtime-forensics.md). Diagnose a live symptom (leak, idle CPU spin, glitch) from instrumentation.
- [Trace forensics](playbooks/trace-forensics.md). Diagnose an existing capture (cpuprofile, trace, spindump, heap snapshot).
- [Feature](playbooks/feature.md). New or changed behavior.
- [Refactoring](playbooks/refactoring.md). A behavior-preserving change to structure: rename, extract, inline, dedupe, or move.
- [Prototype](playbooks/prototype.md). A throwaway sketch that settles an engineering question (behavior, timing, approach, interface) by observation.
- [Visual parity](playbooks/visual-parity.md). Pixel-exact UI equivalence between two implementations or across a styling migration.
- [Authoring a skill](playbooks/authoring-a-skill.md). Writing or editing a SKILL.md.
- [Autonomous run](playbooks/autonomous-run.md). A long task to drive to completion without stopping.
- [Session pickup](playbooks/session-pickup.md). Resuming a prior agent's in-flight work.
- [Pause safely](playbooks/pause-safely.md). Stopping in-flight work so a later agent can resume it.
- [Opening a PR](playbooks/opening-a-pr.md). Commit and PR shape, once publishing is authorized.
