---
name: architect
description: "In a user-driven coordinator session, run parallel design exploration before implementing or delegating code changes crossing a function boundary. Also use for /architect, 'architect this', or 'design this module/API'. Delegates run this workflow only when their assigned prompt requests it."
---

# Architect

Read shared engineering principle references with `bb dev-mode principle --name <name>`. Omit `--name` to list the available names.

Sketch types, function signatures, class shapes, and module boundaries with `not implemented` bodies and pseudocode. Synthesize across multiple model perspectives, then fill in code against the chosen sketch.

The `dev` skill invokes this workflow automatically in the coordinating author session before
implementing or delegating code that crosses a function boundary. That invocation authorizes
the native Arena route below. Delegates run Architect only when their assignment explicitly
requests it; Arena workers stay within their assigned role and never launch nested workflows.

## Start

Open a todolist with one entry per phase before starting.

1. Ground
2. Sketch
3. Agree
4. Implement
5. Scrap

## Phase A: Ground the problem

Build a real mental model of every system the new code touches. Trace the runtime flow, data ownership, and layering through the code, and write down what each subsystem owns, how data moves between them, and where the boundaries are. Naming a file isn't grounding. If the design redefines ownership or layering, also read the history behind the existing shape (commit messages, PRs, design docs) so the rationale becomes a constraint, not a guess.

Skip Phase A only when the work is genuinely greenfield with no surrounding system to integrate.

## Native BB execution

When dev_mode_arena_start is available, use this route after grounding. Read references/runner-prompt.md, references/design-red-flags.md, and references/rationale-template.md. Put their relevant requirements and the grounding directly into the task passed to native Arena; the API accepts one task, not custom per-runner prompts.

By default ask Arena to sketch at least two distinct designs, screen them against the red flags, explain the chosen structure and synthesis rationale, then implement and verify the requested behavior against that sketch. Each candidate owns the full design-and-implementation attempt. With an explicit checkpoint request, scope the Arena task to a reviewable design artifact only and choose checks for that artifact; implementation waits for the human's response. Emit the returned live Arena card and yield. Native Arena owns subsequent judging, synthesis, verification, integration, and the three-round limit. Do not also run the manual coordination phases below.

## Phase B: Sketch

Run the **arena** skill with the design-sketch task and the Phase A grounding artifacts. Pass `references/runner-prompt.md` as each runner's prompt, with the absolute path of this `SKILL.md` filled in.

Use arena's default runners, one Claude and one Codex on the identical runner prompt, so the candidates come from different models.

Design it twice. Require at least two structurally distinct candidates before synthesis, even when the first looks sufficient. This is the `exhaust-the-design-space` principle reference made concrete. Whole-shape alternatives, not point fixes inside one shape.

Screen every candidate against [`references/design-red-flags.md`](references/design-red-flags.md) before synthesis. Assume the next contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Prefer the design where a change that looks right from one file is right for the whole repo.

Compare viable candidates on interface depth. Prefer the design that hides more complexity behind a smaller, simpler public surface. A rich interface can keep call chains short by concentrating capability instead of scattering it across layers.

Arena returns one synthesized design package. Its synthesis decision fills the rationale's "Synthesis decision" section.

## Phase C: Agree (opt-in)

Default: proceed directly to implementation with the synthesized design. No human checkpoint.

Opt in to a checkpoint when the invoker explicitly asks: "/architect with checkpoint," "stop and show me before implementing," or similar. Then surface the synthesized design and pause for sign-off.

The synthesis can ship as its own commit either way, as the "scaffold first" mode of the `foundational-thinking` principle reference. Planned and scoped breakage during fill-in is fine, per the `outcome-oriented-execution` principle reference. For adversarial pressure on the design before implementing, start a design review of the synthesized sketch with `dev_mode_review_start` and kind `design`.

If the human pushes back on the shape (in a checkpoint or after the fact), treat that as Phase A evidence. Re-ground and re-run Phase B before writing more code.

## Phase D: Implement against the sketch

Replace `not implemented` bodies with code, pseudocode with logic. The synthesized sketch is the contract. Deviations from it are signal to surface, not friction to absorb silently. If a function needs a parameter the sketch didn't anticipate, ask whether the sketch was wrong, the requirement was missed, or the implementation is overreaching.

## Phase E: Scrap when the architecture is wrong

If implementation keeps producing friction the sketch can't absorb, throw the sketch out. Don't bolt fixes onto a wrong design, per the `redesign-from-first-principles` and `fix-root-causes` principle references.

The signal is a _pattern_, not single instances. Tells:

- The same shape of workaround appearing repeatedly across unrelated code.
- Multiple unrelated edge cases that all need special-case branches.
- Types that need escape hatches (`any`, casts, optional fields always set in practice) to compile.
- The "we need a lock" reflex when the sketch said the state wasn't shared.
- Callers having to know the abstraction's internal rules to use it.
- Two or more independent Phase D deviations of the same shape across the implementation.

Use judgment. A few edge cases don't condemn an architecture. Some problems are legitimately complex. Complexity in the data is not complexity in the design.

When you scrap:

1. Re-ground on what's been built, as in Phase A.
2. Redesign as if the new constraints had been day-one assumptions, per redesign-from-first-principles.
3. Subtract before adding, per the `subtract-before-you-add` principle reference. The new sketch should be smaller than the old one before it grows.
4. Return to Phase B and re-run arena.

## Outputs

The caller's usage is written first and the type sketch derived from it. One file with new types and signatures for small changes. Module map plus type definitions for larger work. The rationale ships alongside, shaped per `references/rationale-template.md`, including the usage sketch and the synthesis decision.
