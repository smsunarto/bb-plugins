# Scott Engineering guidance

## Workflow routing

- Use the Scott Engineering BB plugin skills for Go, GitHub issues/workflows, and visual explanations.
- Read `game-dev` before planning, implementing, improving, debugging, or reviewing games, including their gameplay, levels, environments, UI/HUD, animation, and assets.
  This includes existing game scenes and features, even when the request does not name the skill or say "game development".
- Read the `show-me` skill before drawing a visual explanation.

## Work Principles

Engineering principles are shared reference documents bundled with the Scott Engineering BB plugin. Read one with `bb scott-engineering principle --name <name>`; omit `--name` to list available names. Each entry below names the reference file and when it applies. Pass its filename without `.md` as `<name>`. In your reply, name each principle that shaped a decision and the specific choice it changed. Cite only principles whose reference you read this session.

**Core**

- **Grug Brain** (`grug-brain.md`). Before designing, implementing, debugging, or refactoring software, read and follow this principle. Judge simplicity by maintainer effort, dependencies, and obscurity. Prefer deletion and the smallest change that fixes the responsible boundary.
- **Foundational Thinking** (`foundational-thinking.md`). Before writing logic: core types and data structures, scaffold-vs-feature sequencing, what concurrent actors share.
- **Redesign from First Principles** (`redesign-from-first-principles.md`). Integrating a new requirement into an existing design. Redesign as if it had been foundational from day one.
- **Attack the Premise** (`attack-the-premise.md`). Two or more fixes that share one premise have failed the same gate. Write the premise down and test it directly before writing another fix that assumes it.
- **Subtract Before You Add** (`subtract-before-you-add.md`). Sequencing an addition, refactor, or rewrite. Remove dead weight first, then build on the simpler base.
- **Minimize Reader Load** (`minimize-reader-load.md`). Reviewing or shaping code that's hard to trace. Count layers and hidden state, collapse one-caller wrappers, shrink mutable scope.
- **Outcome-Oriented Execution** (`outcome-oriented-execution.md`). Planned rewrites and migrations with explicit phase boundaries. Converge on the target architecture, don't preserve throwaway compatibility states.
- **Experience First** (`experience-first.md`). Product, UX, or feature-scope tradeoffs. Choose user delight over implementation convenience.
- **Exhaust the Design Space** (`exhaust-the-design-space.md`). A novel interaction or architectural decision with no precedent. Build 2-3 competing prototypes and compare before committing.
- **Build the Lever** (`build-the-lever.md`). Any non-trivial work. Build the tool that does or proves it (codemod, script, generator), not by hand. The tool is the artifact a reviewer reruns.

**Architecture**

- **Model the Domain** (`model-the-domain.md`). Writing stateful logic, or code that branches a lot or repeats a shape assumption across files. Encode the domain in a structure (state machine, typed model, table or registry, reducer, boundary, the right collection) instead of scattered conditionals.
- **Boundary Discipline** (`boundary-discipline.md`). Wiring validation, error handling, or framework adapters. Guards at system boundaries, trust internal types, keep business logic pure.
- **Type System Discipline** (`type-system-discipline.md`). Designing types or a signature in any typed language. Make illegal states unrepresentable, brand primitives, parse external data at boundaries.
- **Make Operations Idempotent** (`make-operations-idempotent.md`). Designing commands, lifecycle steps, or loops that run amid crashes and retries. Converge to the same end state.
- **Migrate Callers Then Delete Legacy APIs** (`migrate-callers-then-delete-legacy-apis.md`). Introducing a new internal API while old callers exist. Migrate and delete in one wave.
- **Separate Before Serializing Shared State** (`separate-before-serializing-shared-state.md`). Concurrent actors might write the same file, branch, key, or object. Eliminate the sharing first.

**Verification**

- **Fix Root Causes** (`fix-root-causes.md`). Debugging. Trace each symptom back to the first place the system went wrong, reproduce first, and fix it there. A guard is a fix only when the state it handles is legitimate.
- **Prove It Works** (`prove-it-works.md`). After a task, before declaring done. Verify against the real artifact, not a proxy, self-report, or "it compiles".
- **Explain the Number** (`explain-the-number.md`). Before trusting, reporting, or acting on a measured number (speedup, regression, latency, eval result). Name what limits it and rule out that it measured something else.
- **Sequence Work into Verifiable Units** (`sequence-verifiable-units.md`). Multi-step work (sweeps, migrations, runs of similar edits) and how you stack commits and PRs. Break work into small units that each end in a check, verify each before the next, and order delivery so the sequence proves itself.
- **Test Behavior, Not Implementation** (`test-behavior-not-implementation.md`). Writing, changing, or keeping a test. Assert what users can observe. Keep a test only if it fails when the behavior breaks and passes when only the internals change.


**Meta**

- **Encode Lessons in Structure** (`encode-lessons-in-structure.md`). You catch yourself writing the same instruction a second time. Encode it as a lint, metadata flag, runtime check, or script instead of more text.
