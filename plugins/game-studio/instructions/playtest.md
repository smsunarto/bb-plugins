Use `scott-engineering:game-dev` and its game playtesting reference to verify this
game. Read the current GDD, its intended player experience and experiment questions,
and the project's established runtime and QA instructions. Select the appropriate
smoke, feature, regression, visual, or performance passes. State the question and
observable success criterion before each design experiment, then reach the relevant
game states through real input.

When the request names an experiment, find that stable ID in the selected saved
GDD and read its current question and criterion. If it was removed or its meaning
is unclear, resolve that before treating this as a retest. Do not substitute a
different experiment silently. Read the document revision after any design edits
and before the test; record the revision whose criterion you actually tested.
Before running it, define the observation setup: who or what exercises the game,
starting state, relevant prior exposure, allowed help, and what counts as an attempt.
An agent control check cannot establish how a first-time player understands the game.
Keep the tested question, criterion, and setup with the run. Do not change the
criterion afterward to fit the result or replace an earlier run's definition.

Inspect runtime errors and missing assets. Capture and inspect evidence, fix
observed defects, and rerun affected checks. Separate observed actions and player
quotes from interpretation and proposed changes. Record the tested build or
revision and link evidence to the relevant GDD question. When observing players,
avoid leading questions or interrupting their decisions.
Record unexpected observations separately from the selected criterion, with their
game state or capture timestamp. If a crash, intervention, or insufficient
observation prevents evaluating the criterion, leave the design conclusion
unresolved and identify the smallest useful retest.

Distinguish build checks, agent control checks, player feedback, and visual
acceptance. Do not infer enjoyment or accessibility from a passing build or a
screenshot. Report exactly which states and controls were tested, what the
evidence supports, and what remains untested. Never invent player feedback,
approval, or a passing result. Do not publish.

Save actual screenshots and recordings under `canvas/evidence/`. After inspecting
a real playtest, record its metadata in the optional
`canvas/evidence/index.json` manifest. Preserve other runs and append or update
only the run you own. Use this exact shape:

```json
{
  "version": 1,
  "runs": [
    {
      "id": "smoke-001",
      "capturedAtMs": 1735689600000,
      "scene": "MainMenu",
      "outcome": "pass",
      "threadId": "thr_example",
      "testedRevision": "observed-build-or-revision",
      "experiment": {
        "documentId": "design",
        "documentRevision": "saved-document-revision",
        "experimentId": "EXP-menu-readability",
        "definition": {
          "question": "Can a first-time player find the start action without help?",
          "criterion": "The player starts a game within 10 seconds without a hint.",
          "setup": "Observe one first-time player from the main menu. Give no hints; count the first attempt."
        }
      },
      "files": ["canvas/evidence/main-menu.png"]
    }
  ]
}
```

Replace example values with observed results. `id` is stable and unique;
`capturedAtMs` is the actual capture time in Unix milliseconds. `scene`,
`outcome` (`pass` or `fail`), and `threadId` are optional: omit unknown values.
`testedRevision` is optional and identifies the build or source revision actually
run. Do not copy repository HEAD unless it identifies the running build.
For a GDD experiment, include `experiment` with all three identity fields: its saved
document ID, the document revision used for the test, and the stable experiment ID.
The request context supplies current saved document identity and revision.
Omit `experiment` for smoke checks without a GDD question; never invent a link.
Historical records remain valid when a document changes or is removed. A changed
revision does not prove that an earlier outcome still applies to the new design.
`files` must contain one or more existing image or video files, using
project-relative paths strictly under `canvas/evidence/`; do not use absolute
paths or parent segments. Never mark an untested state as passed. Screenshots
and recordings without run metadata remain visible as ungrouped captures.
For new experiment runs, include `experiment.definition` with the tested
`question` (up to 500 characters), `criterion` (1,000), and `setup` (2,000).
All three must be nonempty when the definition is present. The definition is
optional for older records; never backfill it from the current GDD unless the
original tested definition can be verified. A saved revision identifies a file;
it does not recover that file's previous text. Keep the recorded definition when
the design document changes or is removed.
Omit `outcome` when the criterion could not be evaluated. Explain the limitation
in the GDD observations instead of reporting a pass or a design failure.
After recording a real run, link its ID and captures from the GDD experiment.
Keep the observed result separate from interpretation and the next decision.
