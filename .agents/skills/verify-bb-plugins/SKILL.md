---
name: verify-bb-plugins
description: Drive bb-plugins features in this thread's isolated bb test instance and capture browser proof. Use when verifying a plugin change in the real bb UI, reproducing plugin behavior, or collecting handoff evidence.
---

# Verify bb plugins

Prove a plugin's user path in the web UI of this thread's bb test instance. This skill adds a doctor, driving recipes, and a feature map on top of [AGENTS.md](../../../AGENTS.md) **Environment** and **Verification**. Those sections own the test-instance policy, the Monokai and Dark requirements, and the handoff to live. Where they differ from this file, they win.

## Launch

1. Start or update the instance from the repository root. On the first verification in a thread, run:

   ```bash
   bun scripts/test-instance.ts up
   ```

   - **On a Linux host where this shell runs inside bb's host-daemon service** (`cat /proc/self/cgroup` names `bb-host-daemon-…service`), launch it in its own systemd scope instead, or every bb restart kills the test server:

     ```bash
     systemd-run --user --scope --collect --unit="bb-test-$BB_THREAD_ID-$(date +%s)" \
       --setenv=BB_THREAD_ID="$BB_THREAD_ID" bun scripts/test-instance.ts up
     ```

   - Before each later verification, run `bun scripts/test-instance.ts sync` instead. `sync` relaunches nothing, so it needs no scope.
   - Ready means exit 0 and a printed `server`, `cli`, and `reloaded` line. A `FAILED` line means a mirrored write did not apply: read it before driving.
   - A first `up` installs dependencies and builds every plugin, which can take well over two minutes; a relaunch on kept data takes about two. Run it in the background or with a timeout of at least 10 minutes, and wait for it to exit. Its output appears only at the end.
   - Note every `exceptions` line for the handoff.

2. Start a run once. This writes the run's variables to a file that every later shell loads:

   ```bash
   INST=~/.bb-test/instances/$BB_THREAD_ID
   RUN="verify-$(date +%Y%m%d-%H%M%S)"
   mkdir -p "$BB_THREAD_STORAGE/verify/$RUN"
   printf 'INST=%s\nTB=%s\nURL=%s\nRUN=%s\nEV=%s\n' "$INST" "$INST/bb" \
     "http://127.0.0.1:$(jq -r .serverPort "$INST/state.json")" "$RUN" \
     "$BB_THREAD_STORAGE/verify/$RUN" > "$BB_THREAD_STORAGE/verify/current.env"
   ```

3. Begin every later shell command with `set -a; . "$BB_THREAD_STORAGE/verify/current.env"; set +a`.
   - `TB` is the bb CLI routed to the test server. Send every test CLI call through `"$TB"`; a bare `bb` targets live.
   - `RUN` names the browser session. `EV` is the evidence directory, which survives cleanup and `down`.
   - `URL` changes when `up` relaunches on new ports. Rewrite `current.env` with the same `RUN` after a relaunch.

## Doctor

Run the doctor before the first drive, after any bb restart, and after any drive that failed or surprised you:

```bash
.agents/skills/verify-bb-plugins/scripts/doctor.ts --plugin <id> [--plugin <id>]...
```

- It is read-only. It checks that the instance process is alive and its server answers, that `"$TB"` reaches this instance's data dir, that the bb version matches `state.json`, and that the theme is bb Monokai.
- For each `--plugin`, it also checks that the plugin is enabled, running, and loaded from the instance's source copy, that the copy matches the checkout, and that the running build is newer than the copy. A stale build prints the `"$TB" plugin reload <id>` fix.
- Exit 0 means drive. On any `FAIL` line, run the `fix:` it prints, then run the doctor again.
- Without `--plugin` it checks every plugin loaded from the source copy, without the freshness check.

## Drive

1. Open one browser session per run. Set the viewport and dark media before the first `open`:

   ```bash
   agent-browser --session "$RUN" set viewport 1920 1080 2
   agent-browser --session "$RUN" set media dark
   agent-browser --session "$RUN" open "$URL"
   agent-browser --session "$RUN" wait --text "New thread"
   ```

   - The instance mirrors live's theme, plugin settings, and keybindings, and skips onboarding. Confirm Dark and Monokai with the [bb Monokai](features/bb-monokai.md) baseline probe before judging any visual result.
   - Run `agent-browser skills get core` once per thread for the current command reference.

2. Read the [feature map](features/README.md) and follow the file for each feature the change touches. Drive every entry point the file lists for the changed behavior, not just the easiest one.

3. Drive the controls a user drives:
   - Act through roles and accessible names (`find role button click --name …`, snapshot refs). Use a CSS selector only where a feature file names it as a stable handle.
   - After each action, wait on the expected condition (`wait --text`, `wait --url`, `wait --fn`), bounded by `--timeout`. Use a fixed sleep only where a feature file says no condition exists.
   - Drive one command at a time. Concurrent commands on one session race the page.

4. **If a drive fails or the page looks wrong:** run the doctor, then reload `"$URL"` before retrying. Report a failure that persists after a healthy doctor and a reload as a product gap, with its evidence.

## Free agent turns

Many features render only after an agent turn: a thread's environment, message directives, UI blocks, rule delivery. Drive those turns with `scripts/fake-agent.mjs`, a local ACP agent with no model and no network, instead of a paid provider.

1. Register it on the test instance, after recording the current list. bb stores `customAgents` as a JSON string, and the `jq -e` guard stops an empty result from overwriting it:

   ```bash
   "$TB" plugin config provider-acp --json \
     | jq -r '.values.customAgents // "" | if . == "" then "[]" else . end' > "$EV/acp-before.json"
   NEW=$(jq -ce --arg c "$PWD/.agents/skills/verify-bb-plugins/scripts/fake-agent.mjs" \
     --arg r "$EV/reply.md" --arg l "$EV/fake-agent.jsonl" \
     '. + [{id: "verify-fake", displayName: "verify fake (local, no model)", command: $c,
            env: {FAKE_AGENT_REPLY: $r, FAKE_AGENT_LOG: $l}}]' "$EV/acp-before.json") \
     && "$TB" plugin config provider-acp set customAgents "$NEW"
   "$TB" provider list --json | jq -c '.[] | select(.id == "acp-verify-fake") | .available'
   ```

   The last command prints `true`. Run it from the repository root so `$PWD` resolves.

2. Write the reply the agent should give into `$EV/reply.md`, such as a message holding a directive or a ` ```ui ` block. A `{{ECHO}}` in it is replaced by the full prompt bb sent, which proves what context and instructions reached the agent. `$EV/fake-agent.jsonl` logs every message.
3. Start turns only on this provider: `"$TB" thread spawn --project <id> --provider acp-verify-fake --prompt hello --json`, `"$TB" thread tell <id> …`, or a composer whose model picker shows `verify fake`. Any other provider is a paid turn.
4. Restore the list when done: `"$TB" plugin config provider-acp set customAgents "$(cat "$EV/acp-before.json")"`.

- `thread spawn --environment <checkout>` plus one fake turn gives a fixture thread its environment, which Source Control, Kitchen Sink, and other thread panels need. A `--send-at` thread has none until its first turn.
- Point a plugin's background-agent setting at it, such as Source Control's `guideProvider`, before opening a surface that would start a hidden run. Restore it with `"$TB" plugin config <id> unset <key>`.
- `sync` mirrors live's `customAgents` and reloads changed plugins, which removes the fake agent. Register it after each `sync`, never before.
- The fake agent proves plugin plumbing, not model behavior. A step that depends on what a real model decides stays unverified.

## Evidence

Save everything under `$EV`, which survives cleanup and `down`:

- Capture the state before the action, the action's result, and the final URL:

  ```bash
  agent-browser --session "$RUN" screenshot "$EV/01-before.png"
  agent-browser --session "$RUN" screenshot "$EV/02-after.png"
  agent-browser --session "$RUN" get url > "$EV/url.txt"
  agent-browser --session "$RUN" snapshot -i -c > "$EV/after.snapshot.txt"
  ```

- Open and inspect each screenshot. A successful command is not visual proof.
- Prove side effects through a second view: read stored state back with `"$TB" … --json` or reopen the surface after a reload.
- For a match or alignment claim, measure the same property on the reference and the result with one `eval` probe, as AGENTS.md **Verification** requires.
- Write `$EV/result.md` with the feature and entry point, the expected and observed result, the bb version, `RUN`, and any unreachable path with its missing precondition.
- Hand phone-edge, sub-pixel, and resize checks to `scripts/phone-shot.ts`, `scripts/webkit-shot.ts`, and AGENTS.md **Resizable thread side-panel tabs**.

## Cleanup

After every run, including a failed one:

1. Close this run's browser session: `agent-browser --session "$RUN" close`.
2. Delete fixture records this run created: `"$TB" project delete <project-id> --yes` deletes a fixture project and its threads. Then remove `$BB_THREAD_STORAGE/verify/$RUN-fixtures`.
3. Restore any setting the run changed, as each feature file's Gotchas say.
4. Confirm the proof survived: `test -s "$EV/result.md" && ls "$EV"`.

At the end of the thread's work, once it has shipped or been dropped, run `bun scripts/test-instance.ts down`. It deletes everything under `$INST`, never `$EV`. Never stop processes by name. `down` stops only the instance it owns.

## Helpers

- `scripts/doctor.ts [--name <instance>] [--plugin <id>]...` is the read-only health check described under Doctor. `--name` defaults to `BB_THREAD_ID`.
- `scripts/fake-agent.mjs` is the free local agent described under Free agent turns. It reads `FAKE_AGENT_REPLY` and `FAKE_AGENT_LOG` from its environment.
- `scripts/as-thread.sh <thread-id> <cwd> <bb args…>` runs the test CLI as a thread, for commands that act on the calling thread. `"$TB"` drops `BB_THREAD_ID`, so it never can. The helper refuses any server that is not a loopback test port.
- The repository owns the instance lifecycle: `bun scripts/test-instance.ts up|sync|status|down|gc`. Its header documents the layout.

## Gotchas

- A bb restart stops a test server launched without the systemd scope above, and it stops this agent's background shells and subagents either way. The doctor then fails `instance … is not running`. Run `up` again in the scope; it relaunches on the kept data in about two minutes, and fixtures survive.
- The test server stops by itself after four hours. `up` relaunches it.
- A relaunched browser session forgets `set viewport` and `set media dark`, and the app renders light. Run both again and reopen the page whenever agent-browser prints `launched browser`.
- `up` and `sync` exit 1 when a plugin live has enabled is not running there, such as one in a build error: `live bb plugin config <id> --json failed`. The server can still be up, but plugins changed since the last good sync are not reloaded. Run the doctor with `--plugin <id>` and follow its `plugin reload` fix. Report the live plugin's state in the handoff.
- Plugin keybindings register a few seconds after `New thread` renders. A bound key pressed earlier does nothing. See [Vimium](features/vimium.md).
- Home autofocuses the composer, and composer drafts persist across reloads. A bare key pressed there types into the draft. Press `Escape` first, and clear a stray draft before capturing evidence.
- A row's hover buttons in the sidebar sit under the row's full-size link, so `click @ref` refuses them. See [GTD Sidebar](features/gtd-sidebar.md).
