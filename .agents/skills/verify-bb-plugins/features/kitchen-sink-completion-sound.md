# Kitchen Sink: turn completion sound

Kitchen Sink plays a sound in the user's browser when a top-level thread finishes its turn and goes idle, whether or not that thread is focused or the tab is in the background. Subthread completions stay silent. The sound is Cursor's completion sound, read from any connected machine with Cursor installed at `/Applications/Cursor.app`; without one, the browser synthesizes a short two-note chime. With several tabs open in one browser, one tab plays, and only a tab the user has clicked or typed in takes part.

## Sub-features

- `ks-sound-route` serves Cursor's sound at `/api/v1/plugins/kitchen-sink/http/completion-sound`, or 404 when no connected machine has Cursor.
- `ks-sound-chime` synthesizes a two-note chime when the route has no sound.
- `ks-sound-idle` plays once when a top-level thread becomes idle.
- `ks-sound-subthread-silent` stays silent when a subthread becomes idle.
- `ks-sound-one-tab` plays in one tab per browser, and only in a tab that has had a click or key press.
- `ks-sound-blocked-silent` shows nothing and raises no error when the browser refuses audio.

## How to get to it (user POV)

- There is no control. Open bb in a browser, click or type once, and let any top-level thread finish a turn.
- Cursor's sound plays when any connected macOS machine has Cursor installed; otherwise the chime plays.

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin kitchen-sink`.
- A fixture project exists, as in [thread details](kitchen-sink-thread-details.md), for the turn checks.
- `ks-sound-route` and the player election need no fixture. The test instance's machines usually lack Cursor, so expect 404 unless a connected Mac has it installed.
- `ks-sound-idle`, `ks-sound-subthread-silent`, and `ks-sound-one-tab` need a thread to become idle after a turn. Use the free local fake agent (SKILL.md **Free agent turns**, provider `acp-verify-fake`); never a paid provider. Headless Chrome has no audio device to listen to, so these checks count audio graph calls through an in-page probe. The probe tests the trigger mechanism only, not what a speaker plays; say so in `result.md`.

- **Route.** Open `"$URL"` and wait for `New thread`. Run `agent-browser --session "$RUN" eval 'fetch("/api/v1/plugins/kitchen-sink/http/completion-sound").then(r => [r.status, r.headers.get("content-type")])'`. It returns `[404, "text/plain; charset=UTF-8"]` without Cursor (observed on the Linux dev box, with one Linux host), or `[200, "audio/mpeg"]` with it <!-- the 200 branch is unverified: needs a connected Mac with Cursor -->. `curl -s -o /dev/null -w '%{http_code}\n' "$URL/api/v1/plugins/kitchen-sink/http/completion-sound"` gives the same status without the browser. A 404 means the chime path will play.
- **Player election (`ks-sound-one-tab`, no turn).** The tab that plays holds the Web Lock `kitchen-sink:completion-sound`; a tab joins only after a click or key press. Save this probe as `Q`:

  ```bash
  Q='navigator.locks.query().then(s => ({held: s.held.filter(l => l.name.startsWith("kitchen-sink")).length, pending: s.pending.filter(l => l.name.startsWith("kitchen-sink")).length, active: navigator.userActivation.hasBeenActive}))'
  ```

  Reload with `open "$URL"`, wait for `New thread`, wait a few seconds, and run `agent-browser --session "$RUN" eval "$Q"`: `{"active": false, "held": 0, "pending": 0}`. Click something inert twice, such as `agent-browser --session "$RUN" find role button click --name "Toggle sidebar"` (once to close, once to reopen), and rerun: `held` is `1`. Open a second tab with `agent-browser --session "$RUN" tab new "$URL"` and wait for `New thread`; before any gesture there, `held` stays `1` and `pending` `0`. Click `Toggle sidebar` twice in the second tab: `held` `1`, `pending` `1`, so only one tab plays and the other waits its turn. Close it with `agent-browser --session "$RUN" tab close <tab-id>`; the first tab still holds the lock.

- **Install the probe.** Before a turn, run:

  ```bash
  agent-browser --session "$RUN" eval '(() => { window.__ksSound = {osc: 0, buf: 0}; const P = AudioContext.prototype; const o = P.createOscillator, b = P.createBufferSource; P.createOscillator = function () { window.__ksSound.osc++; return o.apply(this, arguments); }; P.createBufferSource = function () { window.__ksSound.buf++; return b.apply(this, arguments); }; return true; })()'
  ```

  Then click `Toggle sidebar` twice so the tab holds the player lock, and confirm with the election probe.

- **Top-level idle (free fake turn).** Spawn a thread that runs now: `"$TB" thread spawn --project <ks-project-id> --provider acp-verify-fake --title "KS sound" --prompt hello --json`, recording its id. Wait for it to finish with `"$TB" thread wait <ks-sound-id> --json` (it waits for `idle` by default), then run `agent-browser --session "$RUN" wait --fn 'window.__ksSound.osc + window.__ksSound.buf > 0' --timeout 10000`. With the 404 route, `osc` is `2` (the two chime notes); with Cursor, `buf` is `1` <!-- the Cursor branch is unverified: needs a connected Mac with Cursor -->.
- **Subthread silent (free fake turn).** Reset the counters with `agent-browser --session "$RUN" eval 'window.__ksSound = {osc: 0, buf: 0}; true'` and install a signal log so a chime can be attributed:

  ```bash
  agent-browser --session "$RUN" eval '(() => { window.__ksSig = []; const jp = JSON.parse; JSON.parse = function (t, r) { const v = jp.call(this, t, r); if (typeof t === "string" && t.includes("workspace-changed")) window.__ksSig.push([Date.now(), t.slice(0, 300)]); return v; }; return true; })()'
  ```

  Spawn a child with parent wake-ups off: `"$TB" thread spawn --parent-thread <ks-sound-id> --parent-notifications off --project <ks-project-id> --provider acp-verify-fake --title "KS sound child" --prompt hello --json`, wait for it, wait five seconds with no condition available, and read `window.__ksSound` and `window.__ksSig`. The log holds the child's `plugin-signal` (`channel: "workspace-changed"`, `payload.parentThreadId` set, `reason: "idle"`) and `osc` stays `0`.

- **One tab plays (free fake turn).** With the probe installed in both tabs of the election step and a click in each (`held: 1, pending: 1`), spawn another top-level fake turn and wait for it. Read the probe in each tab (switch with `agent-browser --session "$RUN" tab <tab-id>` from the `tab` list): the first tab, which holds the lock, reads `{"osc":2}` and the second `{"osc":0}`.
- **Proof.** Save each probe reading to `$EV/ks-sound-<check>.txt`. There is no visible change to screenshot.
- **Cleanup.** Run `"$TB" project delete <ks-project-id> --yes` for the fixture project, close the extra tab, and reload to drop the probe.

## Gotchas

- The `thread.idle` that plays the sound comes from a finished turn. Use the fake agent for every playback check; spawn with `--send-at` only for threads that must stay idle without a turn.
- The sound plays for every top-level idle on the server, including other runs' fake turns on the same instance. A stray chime is not a gap until the `__ksSig` log shows it came from your subthread.
- A child spawned with the default `--parent-notifications auto` wakes its parent for a turn when it finishes, and the parent's idle plays the chime. Pass `--parent-notifications off` for the subthread check.
- `agent-browser tab new` does not always allocate `t2`; read the id from `agent-browser --session "$RUN" tab` before switching or closing.
- A tab joins playback only after a click or key press. Without one, the probe stays at zero and no product gap is shown.
- `navigator.locks.query()` is browser-wide, and a navigated-away page can hold the lock for a moment. Wait a few seconds after `open` before reading the no-gesture state.
- agent-browser actions count as user activation: after any `click` or `press`, `navigator.userActivation.hasBeenActive` is `true` and the tab has joined.
- The route reads `/Applications/Cursor.app` on connected machines only; a sleeping Mac with Cursor still yields 404 and the chime.
- Safari allows audio only from a context a gesture started. Headless Chrome is more permissive, so a pass there does not prove Safari playback.
- The probe lives in the page. A reload or a `launched browser` relaunch drops it; install it again before the next turn.
