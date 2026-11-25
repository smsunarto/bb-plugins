# Devin

Devin adds a provider to bb that runs the Devin CLI, through `devin acp`, in a bb thread. A thread runs either locally in its environment's working directory or on a Devin Cloud VM. You choose Cloud before the first prompt by pressing the `Cloud` toggle above the new-thread composer. Once a thread exists, a banner above its composer links to the Cloud session and offers the command that attaches to it. The plugin also orders Devin's model list. It maps bb's fast toggle, permission modes, and Plan action onto Devin's own Speed and mode options. The plugin has no settings, no `bb devin` CLI, and no agent tools.

## Sub-features

- `devin-provider` lists `Devin` as a bb provider. Without the Devin CLI, it shows as unavailable with an install link (`https://cli.devin.ai/docs`). Signed out, it shows `Run \`devin auth login\` on the machine to sign in.`An expired session shows`Your Devin session expired. Run \`devin auth login\`, then reload.`
- `devin-icon` shows the Devin mark wherever bb shows the provider's icon.
- `devin-models` orders the model picker: Fusion pairs (latest Astra/Sol with the highest offered SWE-2 effort) first, then the latest Astra, Fable, Sol, Opus, and SWE, then `Adaptive`, then the rest grouped by vendor.
- `devin-controls` exposes reasoning `low` through `max`, the permission modes `Accept Edits`, `Auto`, and `Full` only, a fast tier on every model, and bb's Plan action. Fork, manual compaction, and provider-side rename are absent.
- `devin-cloud-toggle` is the `Cloud` toggle button (Devin mark plus `Cloud`, tooltip `Run this thread on a Devin Cloud VM`) above the new-thread composer. It shows only while Devin is the composer's selected provider.
- `devin-cloud-intent` arms Cloud on the server with a press. The armed state survives a reload, expires after 10 minutes, and is used by exactly one new Devin thread. A second press disarms it.
- `devin-target-pinned` fixes Local or Cloud at a thread's first command for the thread's life.
- `devin-session-banner` is the Cloud thread banner. It reads `Devin Cloud` with a `Starting` badge and `Starting a cloud session…`, then an `Active` badge with an `Open in Devin` link to `https://app.devin.ai/sessions/<hex>`. Below that are a read-only `Devin attach command` field holding `devin --cloud -r <session>` and a `Copy Devin attach command` button whose label changes to `Copied` or `Copy failed`. The banner is absent on local Devin threads and on other providers.
- `devin-cloud-repo-note` starts a Cloud thread's first prompt with `Repository: <git remote>. Work there; clone it first if it is not on this machine.` A project with no remote sends nothing. The text is editable in Agent Instructions → Plugin prompts as `cloud-project`.
- `devin-mode-mapping` maps bb's modes onto Devin's: Accept Edits runs Code mode, Auto runs Smart, and Full runs Bypass. A `/plan` turn runs Devin's Plan mode, and the next turn returns to the permission mode's Devin mode. The fast toggle sets Devin's Speed. Devin's own `Speed` entry is removed from the **Agent options** menu.
- `devin-cloud-turn-settle` holds a Cloud turn's end for up to 1.5 s, so Devin's final message lands inside the turn.
- `devin-native-skills` makes skills under `.devin/skills`, `.agents/skills`, and `.claude/skills` (project), and under `~/.config/devin/skills`, `~/.agents/skills`, and `~/.claude/skills` (user), available to Devin threads.

## How to get to it (user POV)

- Choose **Devin** in the new-thread composer's provider and model picker. The `Cloud` toggle then appears above the composer.
- Press `Cloud`, then send the first prompt to start a Cloud thread. Send without pressing it to start a local thread.
- In a Cloud thread, the banner above the composer has `Open in Devin` and `Copy Devin attach command`.
- The composer's reasoning, permission, fast, and Plan controls apply to Devin threads.
- From the CLI:
  - `bb provider list` and `bb provider models devin` show the provider and its ordered models.
  - `bb thread spawn --provider devin …` starts a Devin thread.
  - `bb plugin rpc call devin cloudIntent|setCloudIntent|cloudSession` reads and writes the Cloud state that the toggle and banner show. None is discoverable (`bb plugin rpc list devin --json` prints `[]`), but `call` reaches all three.

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin devin`.
- **Provider id.** Read it first: `"$TB" provider list --json | jq -c '.. | objects | select((.id? // "") | test("devin"))'`. bb 0.50.1 reports `id: "devin"`, `family: "acp"`, `displayName: "Devin"`, and `available: true` on the Linux dev host, plus `strings.signInHint`, `strings.expiredHint`, and `strings.installUrl` (the three hints quoted under Sub-features), `permissionModes: ["accept-edits","auto","full"]`, `supportsFork: false`, `supportsThreadRename: false`, reasoning levels `low`, `medium`, `high`, `xhigh` (`Extra High`), `max`, service tiers `default` and `fast`, and a `logoUrl` under `/api/v1/system/providers/devin/logo`. Use `devin` as `<devin-id>` below.
- **What each tier needs:**
  - **No Devin CLI needed:** the provider row and its hint strings, the icon, the `Cloud` toggle and its armed state, and `cloudSession` reporting `hidden` or `unclaimed`. Whether bb lets you select an unavailable provider in the composer is <!-- unverified: the test host has a signed-in CLI, so the provider was available -->. If it does not, the toggle needs the next tier.
  - **Signed-in Devin CLI on the host, no turn:** the provider is available, and the model list, reasoning, permission, and fast controls work. `available: true` in the provider list is the check; the CLI is `devin` on the host's `PATH` (`~/.local/bin/devin` on the dev box). The test instance runs as the same OS user as live, so it uses the host's existing Devin login. That login is the user's own account; do not run `devin auth login` or change it.
  - **Paid local turn (spends the user's Devin quota; needs approval):** a local thread hides the banner, and the mode, fast, and Plan mapping can be observed.
  - **Devin Cloud (a Cloud-enabled Devin plan, and approval for a Cloud session):** the banner moves from `Starting` to `Active`, the attach command, `Copy`, `Open in Devin`, the repo note, and turn settle.
- **Fixture project with a remote,** for the repo note, and a disposable repo:

  ```bash
  FX="$BB_THREAD_STORAGE/verify/$RUN-fixtures"; mkdir -p "$FX"
  git init -q "$FX/verify-devin" && git -C "$FX/verify-devin" commit -q --allow-empty -m init
  git -C "$FX/verify-devin" remote add origin https://example.invalid/verify/devin.git
  "$TB" project create --name verify-devin --root "$FX/verify-devin" --json | jq -r '.project.id // .id'
  ```

### Provider and models (no turn)

- **Provider row.** The provider-list output in the precondition names `Devin` and reports `available`. With the CLI missing or signed out, bb shows the install link or the sign-in hint (`strings.installUrl`, `strings.signInHint`, `strings.expiredHint` in that output) in the provider picker or the provider settings. <!-- unverified: the test host's Devin CLI is signed in, so no hint rendered; signing out would touch the user's login -->
- **Models.** Run `timeout 90 "$TB" provider models <devin-id> --json > "$EV/devin-models.json"` and `jq -r '.[] | "\(.id)\t\(.displayName)"' "$EV/devin-models.json" | head -12`. The output is an array of models. On 2026-11-24 it began `Fusion (GPT-6.2 Astra + SWE-2 Flash Max)`, `Fusion (GPT-6.2 Sol + SWE-2 Flash Max)`, then `GPT-6.2 Astra`, `Claude Fable 5.2`, `GPT-6.2 Sol`, `Claude Opus 5.5`, `SWE-2.1 Medium`, `SWE-2.1 Ultrafast Low`, then `Adaptive`, then older Claude models, then GPT models. Model ids and names depend on the account. Each model carries `supportedServiceTiers: [{"id":"fast"}]` and a `mode` session option whose values are `Code`, `Smart`, `Ask`, `Plan`, and `Bypass Permissions`. This needs the signed-in CLI.
- **Composer controls.** Open `"$URL"`, wait for `New thread`, and press `Escape`. Open the model picker: it is `button "Opus 5.5"` (or the current model's name) when closed and `Provider, model and reasoning (Ctrl + Shift + M)` once a Devin model is chosen. Its provider rail has buttons `Claude Code`, `Codex`, `Devin`, …; choose `Devin` by ref. The model list then reads `option "Fusion (GPT-6.2 Astra + SWE-2 Flash Max)"`, `Fusion (GPT-6.2 Sol + …)`, `GPT-6.2 Astra`, `Claude Fable 5.2`, `GPT-6.2 Sol`, `Claude Opus 5.5`, `SWE-2.1 Medium`, `SWE-2.1 Ultrafast Low`, `Adaptive`, … in the CLI's order, and the rail shows the Devin mark. Choose the first option. `Permission mode` then offers `menuitemradio`s `Accept Edits`, `Approve for me` (bb's Auto), and `Full Access` only. `Agent options` lists Devin's modes `Code`, `Smart`, `Ask`, `Plan`, `Bypass Permissions`, and no `Speed` entry. Fusion models report no reasoning efforts, so no effort control shows for them. Capture `agent-browser --session "$RUN" snapshot -i -c > "$EV/devin-composer.snapshot.txt"`. Choosing a provider here changes the composer's remembered selection: switch back (rail `Claude Code`, model `Opus 5.5`, or whatever was selected before) when done.

### Cloud toggle and intent (no turn)

- **Toggle appears only for Devin.** With a Devin model selected, a `Cloud` button (Devin mark plus `Cloud`) sits above the composer. Check it with `agent-browser --session "$RUN" eval '[...document.querySelectorAll("button[aria-pressed]")].filter(b => b.textContent.trim() === "Cloud").map(b => b.getAttribute("aria-pressed"))'`, which returns `["false"]`. Switch the composer back to Claude Code: `agent-browser --session "$RUN" wait --fn '![...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Cloud")' --timeout 5000` succeeds. Switch back to Devin for the next steps.
- **Arm.** Run `agent-browser --session "$RUN" find role button click --name "Cloud"`. The probe returns `["true"]`, focus returns to the composer (`document.activeElement` is the `contenteditable` DIV), and `"$TB" plugin rpc call devin cloudIntent --json` prints `{"armed": true}`. Pass no `--input-file`: the method takes no input, and `{}` fails with `invalid_input: HTTP 400: rpc input validation failed`.
- **Tooltip.** `agent-browser hover` does not open it in headless Chrome. Focus the toggle from the keyboard (`press Tab`, then `press Shift+Tab` back onto it) and read `agent-browser --session "$RUN" eval '[...document.querySelectorAll("[role=tooltip]")].map(t => t.innerText)'`: `["Run this thread on a Devin Cloud VM"]`.
- **Survives reload.** Run `agent-browser --session "$RUN" open "$URL"` and wait for `New thread`. The composer keeps its Devin selection and the toggle probe still returns `["true"]`. Server state drives it, not the page.
- **Disarm.** Press it again. The probe returns `["false"]`, and `cloudIntent` prints `{"armed": false}`. The CLI twin is `printf '{"armed":false}' > "$FX/off.json"; "$TB" plugin rpc call devin setCloudIntent --input-file "$FX/off.json" --json`, which echoes `{"armed": false}`; `{"armed":true}` arms it the same way.
- **Expiry.** Arm it, wait more than 10 minutes, reload, and select Devin. The toggle shows unpressed, and `cloudIntent` prints `{"armed": false}`. This is optional, because it needs a 10-minute wait with no condition to poll. <!-- unverified: not driven; an armed intent that long risks turning another Devin thread into a Cloud session -->

### Banner state without a turn

- **Unclaimed vs hidden.** Disarm Cloud first. Then spawn an idle Devin thread and an idle thread on another provider:

  ```bash
  AT=$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)
  "$TB" thread spawn --project <project-id> --provider <devin-id> --title "verify devin local" --prompt hello --send-at "$AT" --json | jq -r '.thread.id // .id'
  "$TB" thread spawn --project <project-id> --provider <other-id> --title "verify other provider" --prompt hello --send-at "$AT" --json | jq -r '.thread.id // .id'
  ```

  `<other-id>` is any non-Devin provider id from `provider list`. Pass it explicitly: an omitted `--provider` uses the project's remembered default, which may now be Devin.

  For each id, write `{"threadId":"<id>"}` to a file and run `"$TB" plugin rpc call devin cloudSession --input-file <file> --json`.
  - The other-provider thread returns `{"state":"hidden"}`.
  - The scheduled Devin thread returns `{"state":"unclaimed"}`: a `--send-at` spawn runs no command, so nothing has pinned its target yet.
  - Open each thread (`open "$URL/projects/<project-id>/threads/<id>"`; `"$URL/threads/<id>"` redirects there) and confirm there is no `Devin Cloud` banner: `agent-browser --session "$RUN" eval '!document.body.innerText.includes("Devin Cloud")'` returns `true`.

- **Spawn may refuse.** If the provider is unavailable, `thread spawn --provider <devin-id>` may refuse. Record the error as the precondition gap. With the signed-in CLI, a `--send-at` spawn succeeds and reports `providerId: "devin"`, `status: "pending"`.

### Paid local turn

- **Precondition.** You have a signed-in CLI and the user's approval to spend Devin quota. Every step in this section is unverified: it runs a Devin turn. The local fake agent cannot stand in, because the behavior under test is Devin's own provider. <!-- unverified: paid Devin turn -->
- **Banner stays hidden.** With Cloud disarmed, send `hello` from the new-thread composer with `Devin` selected. When the turn finishes, `cloudSession` for the thread returns `{"state":"hidden"}`, and no banner renders. <!-- unverified: paid Devin turn -->
- **Mode mapping.** In the thread, open the **Agent options** menu. It lists Devin's mode but no `Speed` entry. Change bb's permission mode to `Full` and send a turn; Devin's mode reads Bypass. Send a turn with `/plan`; that turn runs in Plan, and the next ordinary turn returns to the permission mode's mode. <!-- unverified: where bb shows the active Devin mode -->

### Devin Cloud

- **Precondition.** You have a Cloud-enabled Devin plan and approval to start a Cloud session, which costs more than a local turn. Every step in this section is unverified: it starts a Devin Cloud session. <!-- unverified: Devin Cloud session -->
- **Starting, then Active.** Arm `Cloud`, then send a short prompt from the new-thread composer of `verify-devin`. <!-- unverified: Devin Cloud session -->
  - The thread composer shows a `Devin Cloud` banner with a `Starting` badge, `Starting a cloud session…`, the placeholder `Waiting for the Devin session ID…`, and a disabled `Copy Devin attach command` button.
  - Once Devin names the session, the banner shows `Active`, with `wait --text "Open in Devin" --timeout 120000`.
  - `cloudSession` returns `state: "active"` with `url` and `attachCommand: "devin --cloud -r devin-<hex>"`.
  - The `Open in Devin` link's `href` is `https://app.devin.ai/sessions/<hex>`, without the `devin-` prefix.
- **Copy.** Choose `Copy Devin attach command`. The label changes to `Copied`, or `Copy failed` where the browser denies the clipboard, and returns to `Copy` after about 2 s. <!-- unverified: Devin Cloud session -->
- **One-shot.** `cloudIntent` prints `{"armed": false}` after that thread starts. The next Devin thread runs local. <!-- unverified: Devin Cloud session -->
- **Repo note.** The first turn's instructions include `Repository: https://example.invalid/verify/devin.git. Work there; clone it first if it is not on this machine.` It is not shown in the timeline. Ask Devin in the prompt to quote its repository instruction, or read the turn's start context with `"$TB" thread log <thread-id> --json` and search it for `Repository:`. <!-- unverified: whether agent instructions appear in the thread log --> A local Devin thread never gets the note. Use a real clonable remote if Devin must actually work there.
- **Target pinned.** In the Cloud thread, `cloudSession` stays `active` after more turns. A thread that started local stays `hidden` even if Cloud is armed before its next turn. Arm Cloud, send a second turn in the local thread, and confirm both that `cloudSession` is still `hidden` and that `cloudIntent` is still `{"armed": true}`, because the intent was not consumed. Disarm afterwards. <!-- unverified: Devin Cloud session -->
- **Turn settle.** On a Cloud turn, Devin's last reply is inside the turn: the thread reads idle only after the final message renders. The thread can show running for up to 1.5 s after the visible reply. That delay is expected, not a gap. <!-- unverified: Devin Cloud session -->

### Native skills (paid local turn)

- Create `"$FX/verify-devin/.devin/skills/verify-skill/SKILL.md"` with front matter `name: verify-skill` and a one-line description. In a Devin thread for the project, the composer's skill or slash menu lists `verify-skill`, or Devin can name it when asked. <!-- unverified: where bb lists provider-native skills -->

### Cleanup (every run)

- Disarm Cloud and confirm `"$TB" plugin rpc call devin cloudIntent --json` prints `{"armed": false}`.
- Stop any Cloud session from the Devin web app.
- Run `"$TB" project delete <project-id> --yes`, which deletes the fixture threads before their `--send-at`, and remove `$FX`.

## Gotchas

- **Intent shared across clients.** The armed intent is one server-wide value, not per composer or per project. Any Devin thread whose first command runs while it is armed becomes a Cloud thread, including a scheduled fixture firing later. Always disarm, and confirm with `cloudIntent`, before leaving a run.
- **Paid fixtures.** A `--send-at` Devin fixture becomes a paid Devin turn when its time arrives. Delete the fixture project in cleanup.
- **Icon id.** The plugin's icon slot is registered for provider id `acp-devin`, while bb reports the provider as `devin`. The Devin mark still shows in the picker rail, the model button, and the `Cloud` toggle, because bb serves the provider's own `logoUrl` (`/api/v1/system/providers/devin/logo`). A generic icon there would be a gap; the `acp-devin` registration looks unused.
- **Remembered selection.** Choosing Devin in the new-thread composer is remembered across reloads (it is how the armed toggle shows again after `open "$URL"`). Restore the previous provider and model before finishing.
- **Toggle while submitting.** The toggle is disabled while the composer is submitting. A press during submit does nothing.
- **Banner refresh.** The banner refreshes from the thread's own changes and on reconnect, not on a timer. A stuck `Starting` after the thread shows Devin output is a gap; reload once to confirm before you report it.
- **Cloud model.** Cloud threads use Devin Cloud's default model. The bb model picker applies only to local threads.
- **Rename.** A thread rename stays in bb and never reaches Devin's session.
- **Shared login.** The test instance shares the host's Devin login with live. Treat it as the user's credential: never copy, print, or rotate it.
