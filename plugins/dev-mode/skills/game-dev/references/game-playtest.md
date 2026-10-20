# Choose and run a game playtest

Use the project's existing build checks, runtime driver, and QA plans. Keep the
current engine. For Rampage, use its repository's `agent-game` skill and QA guide
under `.agents/`; this reference supplies coverage, not a replacement runner.

## Match the pass to the change

Select the relevant passes and state their scope. A focused pass does not establish
that the entire game works.

| Pass        | What to exercise                                                                         |
| ----------- | ---------------------------------------------------------------------------------------- |
| Smoke       | Launch, finish loading, reach a usable screen, and perform a primary action              |
| Feature     | Changed behavior, entry and exit states, failure cases, and affected neighboring systems |
| Regression  | Prior failure when reproducible, corrected behavior, and related paths                   |
| Visual      | Required review views, framing, legibility, missing art, clipping, and HUD obstruction   |
| Performance | Reproducible bottleneck measured with the project's diagnostics before optimization      |

Include relevant progression, scene transitions, pause/modal input, failure,
restart, and asset-loading paths. Check other supported device sizes when layout
or controls change. For visual work, use the planned
[review views](scene-direction.md#define-how-the-result-will-be-inspected).

## Exercise the player experience

1. Run relevant compilation and logic checks. Identify the tested revision and
   whether the target is an Editor, a built player, or an offline sandbox.
2. Launch or attach using the established driver and ownership rules. Inspect
   runtime errors and failed asset loads before exercising the changed flow.
3. Reach required states through real input and assert current observations.
   Prefer existing reset, seed, snapshot, or step controls for repeatable setup.
   A debug jump establishes setup, not that navigation or controls work.
4. Inspect rendered gameplay at the actual camera and display scale. Capture
   relevant states; record and inspect motion when timing or animation matters.
   Editor operations, object counts, and state snapshots cannot establish visuals.
5. Fix observed defects and repeat the affected checks. A repeated capture adds
   evidence only when it checks a changed state or resolves an uncertainty.

Reuse existing test hooks. Add a small test-only hook only when normal input
cannot reliably reach or identify a required state and the implementation scope
permits it. Normal gameplay must not depend on that hook. Do not add a second
bridge where the project already has a driver.

Follow the driver's session cleanup rules. Stop task-owned temporary sessions
even after failure and preserve borrowed sessions. Do not install a new automation
stack solely for routine verification. If interaction or visual tools are missing,
run supported checks and identify the unavailable evidence.

## Report what was established

Separate compilation, logic, runtime, player interaction, visual, and performance
results when relevant. Name the tested flow, target, revision, device or viewport,
and evidence locations. Report observed failures and unverified paths explicitly.
Keep results in the response or the project's existing QA reporting system.

A passing build is not a playtest. A screenshot file is not a visual verdict.
Inspect the media and use the project's required review process. Follow `SKILL.md`'s
worker model rules for visual and motion acceptance; this checklist does not replace
that acceptance or authorize a claim beyond the tested scope.

These coverage criteria draw on OhMyGame's
[Game QA](https://github.com/WhiteTowerAI/ohmygame/blob/7e931f07986fa493d5117da16ca4122b8ffa6989/plugins/game-studio/skills/game-qa/SKILL.md)
and [Game Playtest](https://github.com/WhiteTowerAI/ohmygame/blob/7e931f07986fa493d5117da16ca4122b8ffa6989/plugins/web-game-studio/skills/game-playtest/SKILL.md).
