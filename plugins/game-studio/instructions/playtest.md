Use `scott-engineering:game-dev` and its game playtesting reference to verify this
game. Read the current GDD, its intended player experience and experiment questions,
and the project's established runtime and QA instructions. Select the appropriate
smoke, feature, regression, visual, or performance passes. State the question and
observable success criterion before each design experiment, then reach the relevant
game states through real input.

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
      "files": ["canvas/evidence/main-menu.png"]
    }
  ]
}
```

Replace example values with observed results. `id` is stable and unique;
`capturedAtMs` is the actual capture time in Unix milliseconds. `scene`,
`outcome` (`pass` or `fail`), and `threadId` are optional: omit unknown values.
`files` must contain one or more existing image or video files, using
project-relative paths strictly under `canvas/evidence/`; do not use absolute
paths or parent segments. Never mark an untested state as passed. Screenshots
and recordings without run metadata remain visible as ungrouped captures.
