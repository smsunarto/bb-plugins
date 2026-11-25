# Sauce Live

Sauce Live adds `bb sauce`, which lets a bb thread drive a Sauce Labs real device through a signed-in Chrome on the bb server machine. One live-device slot is leased to one thread at a time. The agent looks at the screen, taps, drags, types, waits on the screen or device log, and ends the session. Per-project defaults set how `start` holds the device. The plugin also gives threads the `sauce-live` skill, and in Rampage projects a thread instruction that sends device work to `bb sauce`. It has no app UI, settings, or agent tools.

## Sub-features

- `sauce-help` lists the 17 commands and each command's options without touching the device.
- `sauce-args` refuses a malformed coordinate, wait condition, key, device action, batch step, typed text, or build file with `invalid_value`, before anything reaches the browser.
- `sauce-thread-rule` refuses every lease-bound command from a shell that names no thread, with `no_thread`. `status` and `defaults --project` still answer.
- `sauce-defaults` shows, sets, and clears a project's start orientation (`portrait`, `landscape`, `none`). It needs no device.
- `sauce-no-lease` refuses device commands from a thread that holds no device with `no_session`. `end` reports nothing held, and a batch stops at its first failed step and exits 1.
- `sauce-upload-guard` refuses an upload path that is not a file on the bb server machine with `not_found`.
- `sauce-skill` offers the `sauce-live` skill to every thread.
- `sauce-instructions` adds the "use `bb sauce`" thread instruction only in projects whose name or git remote matches `rampage`.
- `sauce-status` reports the shared browser's state: `ready`, `signed_out`, `session_mine`, `session_untracked`, `session_abandoned`, `capacity_reached`, or `held_by_other_thread`, each with a `next` hint. Uses the shared browser.
- `sauce-sign-in` makes `status --sign-in` click Authenticate with Google once. Uses the shared browser.
- `sauce-catalog` lists builds in Sauce app storage (`apps`) and the real devices for a model (`devices`). Uses the shared browser.
- `sauce-upload` puts an `.apk`, `.aab`, `.ipa`, or `.zip` in Sauce app storage. Writes to the shared Sauce account.
- `sauce-session` covers `start` leasing the device and applying the orientation default or `--orientation`, and `end` releasing it. Device session.
- `sauce-look` saves an upright PNG to thread storage and sets the frame id; `--fast`, `--if-changed`, `--label`, and the `screenshot` alias. Device session.
- `sauce-touch` covers `tap`, `drag`/`swipe`, `--hold`, `--duration`, `--frame` (`stale_frame`), and `no_frame` before the first look. Device session.
- `sauce-text` covers `type` into the focused field and `key enter|backspace|tab|escape|back`. Device session.
- `sauce-wait` covers `wait stable|changed|log:<regex>` and `--wait`/`--look` after an action. A timeout is a result. Device session.
- `sauce-batch` runs quoted steps in order and saves a `batch.json` record to thread storage. Device session.
- `sauce-device` covers `device home|rotate|restart-app`. Device session.
- `sauce-shell` runs an allow-listed `adb shell` command on Android. Device session.
- `sauce-log` covers `log` saving the device log with `--grep`, and `--new` for the panel tail since the last read. Device session.
- `sauce-lease-sharing` covers a second thread getting `held_by_other_thread`, and `start` taking over an abandoned lease after 15 idle minutes. Device session, two threads.

## How to get to it (user POV)

- An agent or a person runs `bb sauce <command>` from a thread's shell. The lease belongs to the thread in `BB_THREAD_ID`, and `defaults` reads the project from `BB_PROJECT_ID`.
- `bb sauce --help` and `bb sauce <command> --help` list commands and limits. `--json` prints machine-readable results, and a failure prints a `code` and a `hint`.
- The `sauce-live` skill is available to threads, and in Rampage projects the thread instruction points the agent to it.
- **Settings → Plugins → Sauce Live** (`$URL/settings/plugins/sauce`) shows only `Plugin details`, `Sauce Live`, the description `Drive Sauce Labs real devices from bb threads with the bb sauce command.`, and bb's `Disable sauce` switch. `"$TB" plugin config sauce --json | jq -c .schema` prints `{}`.

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin sauce`.
- **The shared browser and device.** The test server runs on the live machine as the same user. Every command that reaches the browser (`status`, `apps`, `devices`, `upload`, `start`, and every device command) drives the same `bb-sauce` Chrome and Sauce account that live threads use. The test instance keeps its own lease table and cannot see live's leases.
  - **Browser-free tier** (`sauce-help` through `sauce-skill`): drive it with no precondition. These recipes never reach the browser.
  - **Shared-browser tier** (`sauce-status`, `sauce-sign-in`, `sauce-catalog`): get the user's go-ahead first and confirm no live thread is using Sauce. These commands only read, but `status` may launch a headed Chrome on the server's desktop. `apps` or `devices` can also break a live thread's `start` that is still coming up.
  - **Device tier** (`sauce-upload` and every sub-feature marked "Device session"): needs the user's explicit go-ahead for a live device session. It holds the account's one slot and installs a build on a real device. Do not start one on your own.
- A fixture project and an idle thread, plus a copy of `$TB` that passes a thread and project id. The wrapper drops every `BB_*` variable, so thread-bound calls go through the copy. Record the printed ids:

  ```bash
  FX="$BB_THREAD_STORAGE/verify/$RUN-fixtures"; mkdir -p "$FX"
  git init -q "$FX/verify-sauce" && git -C "$FX/verify-sauce" commit -q --allow-empty -m init
  "$TB" project create --name verify-sauce --root "$FX/verify-sauce" --json | jq -r '.project.id // .id'
  AT=$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)   # macOS: date -u -v+7d +%Y-%m-%dT%H:%M:%SZ
  "$TB" thread spawn --project <project-id> --title "verify sauce thread" --prompt hello --send-at "$AT" --json | jq -r '.thread.id // .id'
  sed 's#^exec #export BB_THREAD_ID="$VT"; [ -z "$VP" ] || export BB_PROJECT_ID="$VP"; exec #' "$TB" > "$FX/tbt" && chmod +x "$FX/tbt"   # <!-- unverified: tbt not exercised -->
  ```

  Then `VT=<thread-id> VP=<project-id> "$FX/tbt" sauce …` runs as that thread. `VT` and `VP` survive the wrapper because they do not start with `BB_`.

Browser-free tier:

- **Help (`sauce-help`).** Run `"$TB" sauce --help`. It exits 0, opens with `bb sauce — Drive a Sauce Labs real device: start, look, tap, drag, type, wait, batch, end`, and names `status`, `apps`, `upload`, `devices`, `start`, `defaults`, `look`, `tap`, `drag`, `type`, `key`, `wait`, `batch`, `device`, `shell`, `log`, and `end`. Then run `"$TB" sauce tap --help`, which lists `--hold`, `--frame`, `--wait`, `--timeout`, `--look`, `--fast`, `--json`, and `--help`. Run `"$TB" sauce look --help`, which lists `--label`, `--if-changed`, and `--fast`.
- **Argument checks (`sauce-args`).** Run each of these and read `.error.code`. Each exits 1 with `invalid_value` and needs no thread; the argument check runs before the thread check. With `--json` the envelope `{"ok":false,"error":{"code","message","hint"?}}` goes to stdout, and stderr repeats the message with the hint in parentheses:
  - `"$TB" sauce tap 1.5 0.5 --json`: `x must be a fraction from 0 to 1, got "1.5"`, hint `Coordinates are fractions of the latest look: 0.5 0.5 is the centre of the screen.`
  - `"$TB" sauce upload ./notes.txt --json`: `upload takes an .apk, .aab, .ipa, or .zip file`.
  - `"$TB" sauce wait soon --json`: `wait takes stable, changed, or log:<regex>, got "soon"`.
  - `"$TB" sauce key space --json`: `key takes one of enter, backspace, tab, escape, back`.
  - `"$TB" sauce device spin --json`: `device takes home, rotate, or restart-app`.
  - `"$TB" sauce batch "fly 0.5 0.5" --json`: `step "fly 0.5 0.5": unknown step "fly"`, hint `A step is one of: tap, drag, type, key, wait, look, device.`
  - `"$TB" sauce shell --json`: `shell needs a command`, hint `For example: bb sauce shell -- getprop ro.product.model`.
- **Thread rule (`sauce-thread-rule`).** Run `"$TB" sauce start "Samsung Galaxy S23" --json`. It exits 1 with `.error.code` `no_thread`, message `bb sauce runs for a bb thread, and this shell names none.`, and a hint naming `BB_THREAD_ID`. The check runs before any lease or browser work. Repeat with `"$TB" sauce look --json` and `"$TB" sauce end --json` and get the same code.
- **Defaults (`sauce-defaults`).**
  - Run `"$TB" sauce defaults --json`. It exits 1 with `no_project` (`This shell names no project.`).
  - Run `"$TB" sauce defaults --project <project-id> --json`. It prints `project` `verify-sauce`, `project_id`, `orientation` `null`, and the note `No default: \`bb sauce start\` leaves the device as Sauce starts it, portrait.`
  - Set the default with `"$TB" sauce defaults --project <project-id> --orientation landscape --json`. It prints `orientation` `landscape`. Read it back from the thread's context with `VP=<project-id> "$FX/tbt" sauce defaults --json`, which also prints `landscape`. <!-- unverified: the tbt read-back -->
  - Clear it with `"$TB" sauce defaults --project <project-id> --orientation none --json`, which prints `null`.
  - Run `"$TB" sauce defaults --project proj_doesnotexist --json`. It exits 1 with `not_found` (`bb has no project proj_doesnotexist.`).
- **No lease (`sauce-no-lease`).** <!-- unverified: not run; the brief counted look, tap, end, and batch as device commands. The source fails them before the browser when no lease exists -->
  - Run `VT=<thread-id> "$FX/tbt" sauce look --json`. It exits 1 with `no_session` and the hint `Start one with \`bb sauce start\`.`Run`VT=<thread-id> "$FX/tbt" sauce tap 0.5 0.5 --json` and get the same code.
  - Run `VT=<thread-id> "$FX/tbt" sauce end --json`. It exits 0 and prints `"ended":false`, `"released":false`, and `This thread held no Sauce device.`
  - Run `VT=<thread-id> "$FX/tbt" sauce batch "look" "wait stable" --json`. It exits 1 and prints `ok: false`, `completed: 0`, and `failed.step` 1 with `failed.code` `no_session`. The second step never ran.
- **Upload guard (`sauce-upload-guard`).** <!-- unverified: not run; the source checks the file before the browser --> Run `VT=<thread-id> "$FX/tbt" sauce upload "$FX/missing.apk" --json`. It exits 1 with `not_found`, and the message names the bb server's hostname. Never pass a real build here: an existing file uploads to the shared account.
- **Skill (`sauce-skill`).** Run `"$TB" skill list --json | jq -c '.skills[] | select(.name=="sauce-live") | {name, pluginId}'`, which prints `{"name":"sauce-live","pluginId":"sauce"}`.
- **Instructions (`sauce-instructions`).** Use the free local fake agent (SKILL.md **Free agent turns**) with `{{ECHO}}` as its reply, so the thread's output is the full prompt bb sent. Create projects `verify-rampage` and `verify-sauce` on disposable repos, spawn one thread in each with `--provider acp-verify-fake --prompt "check instructions" --environment <repo>`, `thread wait` each, and save `"$TB" thread output <thread-id>`. The `verify-rampage` output contains `For Sauce Labs real-device work (Sauce Live, mobile device checks, mobile bug hunts), use the \`bb sauce\` command from your shell, starting with \`bb sauce status\`, and read the \`sauce-live\` skill before \`bb sauce start\`.`; the `verify-sauce` output does not (`grep -c`prints`1`and`0`). The git-remote match was not exercised. <!-- unverified: match on a git remote named rampage -->
- **Settings page.** Run `agent-browser --session "$RUN" open "$URL/settings/plugins/sauce"` and `agent-browser --session "$RUN" wait --text "Sauce Live" --timeout 10000`. The page shows `Plugin details` and the description, and its only control is bb's `Disable sauce` switch.

Shared-browser tier (only after the user's go-ahead): <!-- unverified: not run; shared live browser and account -->

- **Status (`sauce-status`).** Run `"$TB" sauce status --json`. It exits 0 with `.state` and `.next`.
  - `ready` comes with `browser` naming the server's hostname.
  - `session_untracked` means a session no test-instance thread leased is open, most likely a live thread's. Stop the Sauce run there and tell the user.
  - `signed_out` means the shared profile lost its sign-in.
  - Failures: `browser_unavailable` means `agent-browser` is missing from the server's PATH or the profile `~/.agent-browser/profiles/sauce-live` is missing. Report it as the unmet precondition.
- **Sign-in (`sauce-sign-in`).** Only on `signed_out`, and only with the user's go-ahead: run `"$TB" sauce status --sign-in --json` once. It returns `ready`, or fails `signed_out` with a hint to sign in by hand.
- **Catalog (`sauce-catalog`).** Run `VT=<thread-id> "$FX/tbt" sauce apps --json`. It prints `apps` as `{id, label}` entries and `newest_first: true`. Run `VT=<thread-id> "$FX/tbt" sauce devices "Galaxy S23" --json`. It prints `app`, and `devices` with `name`, `status`, `os`, and `screen`, plus `shown` and `total` or `truncated`.

Device tier (only after the user approves a live device session): <!-- unverified: not run; shared live device -->

- **Session (`sauce-session`).** Record a build label from `apps` and a device name and OS from `devices`. Set a default with `"$TB" sauce defaults --project <project-id> --orientation landscape`. Then run `VT=<thread-id> VP=<project-id> "$FX/tbt" sauce start "<device>" --os "<os>" --app "<label text>" --json`, which takes 10 s to 3 min. It prints `session_url`, `orientation` `landscape`, `orientation_from` `project_default`, and `lease_idle_minutes` 15. `"$TB" sauce status --json` from no thread then reads `session_untracked`, and from `VT=<thread-id> "$FX/tbt"` it reads `session_mine`.
- **Look (`sauce-look`).** Run `VT=<thread-id> "$FX/tbt" sauce look --label first --json`. It prints `path` under the thread's storage `sauce/` directory, `frame` 1, `kind` `full`, `rotation`, and `changed`. Open the PNG. Run `… sauce look --fast --json` next, which gives `kind` `fast`. Then run `… sauce look --if-changed --json` on a still screen, which prints no `path` and keeps the frame.
- **Touch (`sauce-touch`).** Run `… sauce tap <x> <y> --frame <frame> --wait changed --look --json`, which prints `gesture` `tap`, a `wait` with `met`, and a nested `look`. A tap with an older `--frame` fails `stale_frame`. After `… sauce device rotate`, a tap fails `no_frame` until the next look. Run `… sauce drag 0.5 0.8 0.5 0.2 --duration 300 --json` for `gesture` `drag`.
- **Text (`sauce-text`).** Tap a text field, then run `… sauce type "verify text" --wait changed --look --json`, which prints `typed` 11. Run `… sauce key enter --json`. `… sauce key back --json` presses BACK on Android and fails `unsupported` on iOS.
- **Wait (`sauce-wait`).** Run `… sauce wait stable --timeout 5s --json`, which prints `condition`, `met`, `samples`, and `waited_ms`, or `timed_out: true` with exit 0. Run `… sauce wait "log:Exception" --timeout 10s --json`.
- **Batch (`sauce-batch`).** Run `… sauce batch "look" "tap 0.5 0.5" "wait stable --timeout 5s" "look --fast" --json`. It prints `ok: true`, `completed` 4, and `record`, the path of the saved `batch.json`.
- **Device actions (`sauce-device`).** Run `… sauce device home --json` (`done: home`) and `… sauce device restart-app --json` (`done: restart_app` with a `next` hint).
- **Shell (`sauce-shell`, Android).** Run `… sauce shell --json -- getprop ro.product.model`, which prints `command`, `output`, and `truncated`. `logcat` is refused by Sauce.
- **Log (`sauce-log`).** Run `… sauce log --grep "Exception" --json`, which prints `path` to `<stamp>-device.log`, `lines`, and `matches`. Run `… sauce log --new --json` twice. The second prints only lines after the first, with `since` naming the previous read.
- **Lease sharing (`sauce-lease-sharing`).** Spawn a second idle fixture thread. `VT=<second-id> "$FX/tbt" sauce look --json` fails `held_by_other_thread`, and the message names the holder thread. The abandoned takeover needs 15 idle minutes and holds the slot meanwhile, so skip it unless the user asks.
- **End.** Run `VT=<thread-id> "$FX/tbt" sauce end --json`. It prints `released: true`. `"$TB" sauce status --json` then reads `ready`.
- **Proof.** Save each command's JSON as `"$EV/sauce-<sub-feature>.json"`, and copy look PNGs from the printed `path` into `$EV`.
- **Cleanup.** End any session this run started first. Then run `"$TB" sauce defaults --project <project-id> --orientation none`, `"$TB" project delete <project-id> --yes`, and remove `$FX`.

## Gotchas

- Never run `agent-browser` against the Sauce browser, not even to read. A command with other launch settings restarts the shared Chrome and closes whatever session is open there, including a live thread's.
- Both the test instance and live drive one browser. A test `start` while a live session is open fails `session_active`, which is the safe outcome, but `apps`/`devices` during a live thread's pending start can derail it. Confirm the device is idle with the user before the shared-browser tier.
- Neither bb sees the other's lease. A session the test instance starts reads `session_untracked` from live, and live agents are told not to end it. Always `end` before `bun scripts/test-instance.ts down`. A session left open holds the account's one slot until Sauce idles it out.
- The `"$TB"` wrapper unsets every `BB_*` variable, so `BB_THREAD_ID=… "$TB" sauce …` still runs with no thread. Use the `tbt` copy from the preconditions.
- `status` from no thread is allowed and passes an empty thread id. It never reports `session_mine`.
- When the browser is not running, the first browser-tier command launches a headed Chrome under a systemd user scope on the server's display. On this machine that opens a window on the user's desktop.
- A wait that times out exits 0 with `timed_out: true`, and a gesture result with `after_error` means the touch landed. Neither is a product failure, and repeating the touch is wrong.
- Thread-storage writes (look PNGs, logs, batch records) go to the fixture thread's storage. A thread spawned with `--send-at` has no environment until its first turn (one free fake-agent turn gives it one), so a batch can come back without `record`. <!-- unverified: batch record path -->
- The skill's "Rampage notes" and the `rampage` instruction match are project-specific, not a general feature.
