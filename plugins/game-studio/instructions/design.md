Use `game-dev` to develop this game's design. Read
`game_studio_canvas_context`, then inspect the main design document, boards,
and local assets. Preserve the user's distinctive choices and existing work.

Keep the game design document (GDD) concise and current. Use its existing
structure where useful; the starter template is a guide, not a required rewrite.
Maintain these decisions at the level needed for the next playable slice:

- Vision: player fantasy, target audience, platform, controls, camera, and session length
- Art direction: shared shape language, palette, materials, and accepted references
- Design pillars: three to five concrete principles, each with a decision it guides
- Core loop: player action, feedback, meaningful choice, and repeat or progression
- Current playable slice: essential behaviors, content, and win, fail, or end states
- Constraints and exclusions: accessibility, technical limits, production scope, and deferred features
- Open questions and experiments: uncertainty, smallest prototype, success criterion, and observed evidence

Start from the intended player experience. Describe what the player does and
notices before naming systems. Detail the current slice; keep later work coarse.
Treat deliberate tension between pillars as a design choice to understand.
Do not erase it through generic rewrites or add features to fill every blank.
Label assumptions and unresolved decisions. Never invent approval or playtest data.

For each consequential unknown, propose the smallest playable experiment and
an observable success criterion. Give it a stable experiment ID such as
`EXP-dash-readability`, keeping its question, criterion, evidence, interpretation,
and next decision together in the GDD. Keep the ID when revisiting the same question.
Use a new ID for a different question; keep earlier results under the definition tested.
Include enough timing, sound, and visual feedback
to test the intended experience. Record observations separately from interpretation;
build success or screenshots alone do not prove that a design works in play.

Link current-slice assets to their canvas nodes or versioned contracts. Keep
camera, scale, style, consumer, and acceptance criteria in one authoritative
contract; reference it instead of copying specifications into several documents.
Keep canvas nodes aligned with the design and preserve the user's arrangement.
Record changed decisions and their reasons where they belong in the GDD.
Link observed evidence run IDs to the experiment. Recorded document revisions are
historical provenance; inspect the captures and tested revision before treating
an earlier outcome as evidence for the current design.
Preserve each run's recorded question, criterion, and setup when the GDD changes.
If an older run lacks that definition, report the gap instead of reconstructing
it from today's document.

Use the skill's required design owner for visual judgment and Game Studio tools
for generation. Ask for authentication when a required service needs it. Keep
paid generation within the user's authorized scope and budget. Preserve unrelated
project files. Report the next experiment and remaining product decisions.
