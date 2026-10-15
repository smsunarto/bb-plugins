# {{title}}

This living game design document records the current design. Unanswered prompts
are open decisions, not accepted requirements. Keep the next playable slice
detailed and later work brief. Link asset contracts and evidence at their source.

## Vision

- **Pitch and player fantasy:** Define what the player does and wants to experience.
- **Play context:** Define the audience, platform, controls, camera, and session length.
- **Art direction:** Define shared shape language, palette, material treatment, and accepted reference paths. Mark undecided choices.

## Design pillars

Define three to five principles. Give each a short title, intended experience,
and a concrete decision it guides. Record intentional tension between principles.

## Core loop

Define the repeated sequence: player action, feedback or consequence, meaningful
choice, and repeat or progression. Describe what sustains a full session.

## Current playable slice

- **Playable scope:** Define essential behaviors, content, and win, fail, or end states.
- **Asset contracts:** Link required canvas nodes or contracts, their consumers, and acceptance criteria.
- **Acceptance:** Define observable behavior that demonstrates the slice works with its real controls.

## Constraints and exclusions

- **Constraints:** Record relevant accessibility, readability, hardware, and production limits.
- **Excluded or deferred:** Record features outside this slice so they do not become implicit requirements.

## Questions, experiments, and evidence

For each consequential unknown, record the question, smallest playable experiment,
and observable success criterion under a stable ID such as `EXP-dash-readability`.
Keep the ID when revisiting the same question. Use this structure for the experiment
being tested next; leave later experiments brief:

- **Experiment ID:** [stable ID using letters, numbers, underscores, or hyphens]
- **Question:** [the important, answerable uncertainty]
- **Playable test:** [smallest intervention and the state or controls to exercise]
- **Observation setup:** [who or what plays, starting state, prior exposure, allowed help, and what counts as an attempt]
- **Criterion:** [observable behavior that would support or contradict the design]
- **Observed evidence:** [actual run IDs, tested build or revision, and capture links]
- **Interpretation:** [what the observations suggest, with uncertainty]
- **Next decision:** [keep, change, or test again, and why]

Record playtest evidence only after observing a real run. Preserve the tested
question, criterion, and setup with each run, even when this document changes.
Keep unexpected observations separate from the selected criterion. If the test
could not answer the question, record the limitation and next test without a verdict.
