---
name: verify-bb-plugins
description: Verify bb-plugins through the pinned bb web app. Use after plugin UI changes, when reproducing live behavior, or when static checks need user-path evidence.
---

# Verify bb plugins

Prove the changed user path in the pinned bb app. Static checks support this proof. They do not replace it.

## Launch

Start the repository dev loop before the first plugin edit. The package alias
calls `bb-kit dev-instance workspace --watch`. Leave it running.

```bash
bun run dev
```

Create one run ID. The helper starts a bb runtime for this run alone: it borrows
the workspace instance's checkout, comes up on its own ports and its own data
directory, installs the workspace plugins into it, and reserves one browser
session. Runs do not share a bb, so several can be in flight at once.

```bash
RUN_ID="verify-$(date +%Y%m%d-%H%M%S)"
.agents/skills/verify-bb-plugins/scripts/control launch "$RUN_ID"
source ".scratch/verify-bb-plugins/runs/$RUN_ID/run.env"
```

Wait until launch exits and `run.env` exists. Starting the runtime is seconds,
but installing the plugins into its empty bb can take more than one tool yield.
A first-ever workspace instance clones and installs bb, which is minutes.

The helper prints the app URL, the runtime name, the instance whose checkout it
borrowed, the browser session, and the evidence directory. Use those values for
the whole run.

## Doctor

Run the doctor before browser work and after unexpected behavior.

```bash
.agents/skills/verify-bb-plugins/scripts/control doctor
```

The doctor checks this run's runtime, its isolated data directory, every workspace plugin, and the bb Monokai theme. Fix a failed check before driving the UI.

## Drive

Read [the feature map](features/README.md). Open only the feature file for the changed path.

Load the current browser command reference before the first browser command.

```bash
agent-browser skills get core --full
agent-browser --session "$BROWSER_SESSION" set viewport 1728 1117 2
agent-browser --session "$BROWSER_SESSION" open "$BB_APP_URL"
agent-browser --session "$BROWSER_SESSION" wait --text "New thread"
```

Set the viewport before the first `open`. A fresh session renders at device pixel ratio 1 on a 1280x577 window, which rasterises 16px icons onto 16 physical pixels and crops the app. The 2x setting persists for the session across `open` and `reload`.

Drive the same controls a user drives. Prefer roles, labels, and visible text. Use CSS only for stable plugin contracts listed in the feature file.

## Evidence

Capture the initial state, the action result, and the final URL. Use a DOM snapshot when the visible result depends on structure.

```bash
agent-browser --session "$BROWSER_SESSION" screenshot body "$ARTIFACT_DIR/01-initial.png"
agent-browser --session "$BROWSER_SESSION" screenshot body "$ARTIFACT_DIR/02-result.png"
agent-browser --session "$BROWSER_SESSION" get url > "$ARTIFACT_DIR/result-url.txt"
agent-browser --session "$BROWSER_SESSION" snapshot > "$ARTIFACT_DIR/result-snapshot.txt"
```

Inspect each screenshot. Do not treat a successful command as visual proof.

Record the expected result and the observed result in `$ARTIFACT_DIR/result.md`. State the tested feature, bb URL, and run ID.

## Cleanup

Close only the session created for this run. Keep the evidence directory.

```bash
.agents/skills/verify-bb-plugins/scripts/control cleanup "$RUN_ID"
test -d "$ARTIFACT_DIR"
```

Do not stop the repository watcher. Do not reload the live desktop app.

## Helpers

- `scripts/control launch <run-id>` starts this run's bb runtime and prepares it.
- `scripts/control doctor [run-id]` checks this run's runtime. It reads `RUN_ID` when you omit one.
- `scripts/control cleanup <run-id>` closes the browser session and destroys the runtime. The evidence stays.
- `features/README.md` maps the eight representative plugin paths.

## Gotchas

- Always use this run's URL from `run.env`. Every runtime has its own, and it is never the workspace instance's.
- Run `cleanup` even when the run fails. A runtime left running holds three ports and a data directory.
- The app port is not the Server port. Set browser and `BB_SERVER_URL` traffic to the App port.
- Every runtime shares one checkout and one plugin `dist/`. Never load a test change into the desktop app without approval.
- Keep screenshots and snapshots under `.scratch/verify-bb-plugins/runs/<run-id>/evidence/`.
- Do not drive one browser session from concurrent commands. Commands can reset or race the active page.
