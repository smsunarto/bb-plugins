---
name: verify-bb-plugins
description: Verify bb-plugins through the pinned bb web app. Use after plugin UI changes, when reproducing live behavior, or when static checks need user-path evidence.
---

# Verify bb plugins

Prove the changed user path in the pinned bb app. Static checks support this proof. They do not replace it.

## Launch

Start the repository watcher before the first plugin edit. Leave it running.

```bash
env BB_CLI="$PWD/scripts/bb-dev-cli" bun run dev
```

Create one run ID. The helper starts the pinned app, resets its test baseline, and reserves one browser session.

```bash
RUN_ID="verify-$(date +%Y%m%d-%H%M%S)"
.agents/skills/verify-bb-plugins/scripts/control launch "$RUN_ID"
source ".scratch/verify-bb-plugins/runs/$RUN_ID/run.env"
```

Wait until launch exits and `run.env` exists. The pinned app setup can take more than one tool yield.

The helper prints the app URL, browser session, and evidence directory. Use those values for the whole run.

## Doctor

Run the doctor before browser work and after unexpected behavior.

```bash
.agents/skills/verify-bb-plugins/scripts/control doctor
```

The doctor checks the pinned app, its isolated data directory, every workspace plugin, and the bb Monokai theme. Fix a failed check before driving the UI.

## Drive

Read [the feature map](features/README.md). Open only the feature file for the changed path.

Load the current browser command reference before the first browser command.

```bash
agent-browser skills get core --full
agent-browser --session "$BROWSER_SESSION" open "$BB_APP_URL"
agent-browser --session "$BROWSER_SESSION" wait --load networkidle
```

Drive the same controls a user drives. Prefer roles, labels, and visible text. Use CSS only for stable plugin contracts listed in the feature file.

## Evidence

Capture the initial state, the action result, and the final URL. Use a DOM snapshot when the visible result depends on structure.

```bash
agent-browser --session "$BROWSER_SESSION" screenshot "$ARTIFACT_DIR/01-initial.png"
agent-browser --session "$BROWSER_SESSION" screenshot "$ARTIFACT_DIR/02-result.png"
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

- `scripts/control launch <run-id>` starts and prepares the pinned app.
- `scripts/control doctor` checks the current pinned baseline.
- `scripts/control cleanup <run-id>` closes the owned browser session and releases its lock.
- `features/README.md` maps the five representative plugin paths.

## Gotchas

- The pinned app uses `http://localhost:16493` today. Always use the URL that the helper reads from `bb-dev-app status`.
- The app port is not the Server port. Set browser and `BB_SERVER_URL` traffic to the App port.
- The pinned and desktop instances share `dist/`. Never load a test change into the desktop app without approval.
- Plugin type sync can update SDK pins. Review manifest changes before keeping them.
- Keep screenshots and snapshots under `.scratch/verify-bb-plugins/runs/<run-id>/evidence/`.
