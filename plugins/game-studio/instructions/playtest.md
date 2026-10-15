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

Inspect runtime errors and missing assets. Capture and inspect evidence, fix
observed defects, and rerun affected checks. Separate observed actions and player
quotes from interpretation and proposed changes. Record the tested build or
revision and link evidence to the relevant GDD question. When observing players,
avoid leading questions or interrupting their decisions.

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
        "experimentId": "EXP-menu-readability"
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
For a GDD experiment, include `experiment` with all three fields: its saved
document ID, the document revision used for the test, and the stable experiment ID.
The request context supplies current saved document identity and revision.
Omit `experiment` for smoke checks without a GDD question; never invent a link.
Historical records remain valid when a document changes or is removed. A changed
revision does not prove that an earlier outcome still applies to the new design.
`files` must contain one or more existing image or video files, using
project-relative paths strictly under `canvas/evidence/`; do not use absolute
paths or parent segments. Never mark an untested state as passed. Screenshots
and recordings without run metadata remain visible as ungrouped captures.
After recording a real run, link its ID and captures from the GDD experiment.
Keep the observed result separate from interpretation and the next decision.
