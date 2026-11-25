# Captain

A Captain is a long-lived bb thread that runs other threads for you. You hand it work in plain words; it briefs crew threads, checks what they report, and tells you only what needs you.

A thread can be a Captain, with its own rules, Drive and repos, and it runs crew on Tasks: dispatch, verdicts, tells, asks and status (build steps 2 to 4 of the Captain spec). A background check wakes a Captain once per crew thread that stays stalled for 15 minutes and retries undelivered answers.

Each role starts crew on a model ladder set in Captain settings (Crew models): ordered provider, model and reasoning rungs, Codex after the role's own preset by default. Dispatch takes the first rung that can start now. A Claude Code or Codex rung needs a ready Account Pooler account for that model family, read from the pool's `status.get`. Any other provider, such as an ACP agent like Google Antigravity (`acp-antigravity`), has no pool accounts; every rung is skipped when its provider is missing or unavailable on the machine its thread spawns on (the preset's machine, else the repo's connected default source, as Tasks picks it), or does not take the role preset's permission mode (ACP agents take `full` and `accept-edits`, not `auto`). Captain keeps its rung presets on the role preset's permission mode. A known machine that is not connected, or a repo with no connected checkout, refuses the rung, as Tasks would. Only candidate rungs are read: after the failed one in the fallback, and only the forced one under `--rung`. Each machine, project and provider list is read once per dispatch or background pass, with a 5-second deadline. A machine Captain cannot tell skips nothing. A candidate rung whose reads fail starts anyway under dispatch; the fallback waits for the next pass instead. A forced `--rung` skips the pool but not that check. A crew thread that fails on a rate limit bb will not retry, before it reports, is restarted on the next eligible rung and archived, and the Captain gets one wake line. An ACP agent's error reaches bb as text with no classification, so its quota and rate-limit wording (`RESOURCE_EXHAUSTED`, `exhausted your quota`, `rate limit`, `429`) counts; an ACP agent that reports a quota as a stop reason ends its turn without an error, and only the stall wake catches it. After the last rung the wake says Blocked. Each rung runs through a Tasks preset Captain owns, such as `Captain Review · 2`, copied from the shared `Review` preset; Captain never changes the shared presets other dispatches use. The Needs you banner arrives in a later step.

```sh
bb captain new --name Plugins --repo bb-plugins [--repo rampage] [--prompt-file purpose.md]
bb captain repo add rampage [--tasks RAMP]
bb captain repo remove RAMP
bb captain drive read CREW.md
bb captain drive write NOTES.md --file ./notes.md
bb captain icon Star                 # or --clear, or no argument to show it
bb captain archive

bb captain create --project PLUG --title "Fix the thing" --description-file brief.md [--status todo] [--priority low]
bb captain claim PLUG-9 PLUG-10
bb captain release PLUG-9
bb captain dispatch PLUG-14 PLUG-15 --role Implement [--base-branch <ref>] [--rung <n>] [--again] [--dry-run]
bb captain dispatch PLUG-14 --role Review
bb captain dispatch PLUG-9 --role Implement --thread thr_abc
bb captain verdict PLUG-14 review passed --head <sha> [--ship]
bb captain verdict PLUG-14 review skipped --reason "Docs only"
bb captain tell PLUG-14 --role Implement --message-file findings.md
bb captain tell --all --rule --message "Never push to main."
bb captain tell --stalled --message-file nudge.md
bb captain ask "Pick the Unity account" --task PLUG-19 --option Studio --option Personal --detail-file why.md
bb captain ask resolve a7 --answer Studio
bb captain ask show a7
bb captain status [--since <cursor>] [--all]
```

The Overview's Tasks list shows only the Captain's own open tasks: ones it created with `create` (in one of its repos), dispatched crew on once the thread started, or claimed with `claim`; `release` drops a mistaken claim. Crew the background check adopts as children count as dispatched. Tasks records no creator, so Captain keeps that record in its `task_owners` table. Tasks from before the record are placed once, from the first start: by crew threads in `crew_roles`, by a brief's `You are a crew thread for the <name> Captain.` header, by a Tasks system line written from the Captain's thread, by a follow-up's `from <key>`, and last by a comment from the Captain's own thread. Crew and brief owners are written before any comment is read. A run that fails or cannot read a project is retried after 30 seconds, doubling to 10 minutes; until it finishes, the Tasks section says older tasks may be missing. A task none of these place belongs to nobody until a Captain claims or dispatches it.

An ask's options are button labels, ≤12 columns each (wide characters count 2), with no ⭐/markers; the reasoning goes in `--detail-file`.

Long text goes through a file on the calling machine (`--message-file`, `--detail-file`). The stdin flags (`--message-stdin`, `--detail-stdin`) take one line only, as every bb plugin CLI stdin flag does.

Run `bb captain --help` for every option. Every command takes `--json`.

## Who may act for a Captain

- A call from the user's terminal, with no thread, names its Captain with `--captain`.
- A thread-bound call acts only for its own Captain. A Captain thread acts for itself, and `--captain` may name only that same Captain.
- A crew thread is the child of a Captain in bb. Crew may run `drive read`, `drive write` and `ask show`, and nothing else that acts for a Captain.
- Other threads, neither a Captain nor its crew, are refused by every command that acts for a Captain, `drive read` and `drive write` included. They may still run `ask show` and `bb captain new`. Crew may not run `new`, nor may any thread ever dispatched as crew.
- `ask resolve` takes the user's terminal, the banner, or the ask's own Captain thread. The Captain may answer its own decision, access or improve asks, and may rerun any answer to retry its send. Only the user gives a ship ask its first answer.
- Each ask records who answered it, `user` or `captain`, and `ask show` prints it. A superseded ship ask reads `captain`; asks answered before this was kept read `unknown`. `captain-ship` ships only on a Merge whose record says `user`.
- A review verdict supersedes the task's open ship asks from every Captain, not only the one recording it. Another Captain whose ask closes is sent its `Superseded` answer, as a resolved ask is.
- Crew read the whole Drive and write only under `crew/`. `CAPTAIN.md`, `CREW.md`, `NOTES.md`, `skills/` and every other path are the Captain's. The check uses the real path, so a symlink cannot point a crew write elsewhere.

### Limits

These checks stop cooperative clients' mistakes, not a hostile caller. bb gives a plugin no authenticated caller:

- The calling thread is request metadata the CLI reports. A call that drops `BB_THREAD_ID` reads as the user's terminal.
- An RPC handler sees only `client` or `plugin`, and the bb app, the `bb` CLI and every agent shell are all `client`. These RPC methods act for any client: `resolveAsk`, `setLadder`, `defer`, `markSeen`, `adopt`, `newCaptain`, `setIcon`, `routineAction` and `saveRoutine`. Any agent can reach them with `bb plugin rpc call captain <method>`.
- So an ask's `answeredBy` of `user` means the answer did not come from the CLI in a thread: the banner, the user's terminal, or any client that calls `resolveAsk`. It does not prove the user clicked.
- Crew on the server's machine can write the Drive by path.

## Routines

A routine is a message a Captain gets on a schedule, like a Grok Bot routine: the Captain does its instruction under its usual rules and reports in its own thread. Each one is a script automation in bb's built-in Automations plugin, in the Captains project, named `Captain <name> · <routine>`; Captain keeps no timer of its own.

```sh
bb captain routine add --name "Stalled crew sweep" --cron "0 9 * * 1-5" [--timezone <iana>] --prompt-file sweep.md [--paused]
bb captain routine add --name "Check the deploy" --in 2h --prompt-file check.md   # or --at <iso>
bb captain routine list
bb captain routine show <id-or-name> [--runs]
bb captain routine update <id-or-name> [--name …] [--cron …] [--timezone …] [--in …] [--at …] [--prompt-file …]
bb captain routine pause|resume|remove <id-or-name>
bb captain routine run <id-or-name>      # a test run, now
```

- `add` and `update` print the schedule in words and the next run. A new routine waits for its next time. A new `--in` or `--at` arms a one-shot that already ran; a paused one stays paused. `--timezone` defaults to the bb server's.
- Limits: 20 routines per Captain, names unique per Captain, instructions up to 4000 characters, a cron at most every 15 minutes.
- A run sends the Captain `[captain] routine <id> "<name>" · scheduled` (or `· test`) and the text of `instructions/routine.md`, with `queue-if-active`: it waits behind a running turn instead of steering into it. While that message is still queued, or the queue cannot be read, the next run is skipped. Each run is recorded as `sent`, `queued`, `skipped` or `failed`, 20 per routine.
- Only a Captain's own thread, for its own routines, or the user's terminal with `--captain` manages routines; crew and other threads are refused. This guards against mistakes by cooperative clients, not a hostile one: the calling thread is request metadata the CLI reports, not an authenticated identity. The Captain sets one only when the user asks in its thread, following the `captain-routines` skill.
- Archiving a Captain pauses its routines; deleting it removes them. A `routines` maintenance service, apart from the crew check, schedules again a routine whose automation is gone, deletes a Captain automation no routine owns (only one running exactly Captain's script), and retries any Automations call that failed.
- The Captain's Overview tab gains a Routines section in a later step.

## What `new` sets up

- A Claude Code thread on the bb server's machine, pinned, in the shared **Captains** project (`~/Captains`), carrying `pluginMetadata { captain: { name } }`.
- Empty `CAPTAIN.md`, `CREW.md` and `NOTES.md` in its thread storage, the Drive. They are created only when missing, so a rerun never overwrites them.
- A linked Tasks project for each repo, linking the one already linked to that bb project or creating one.
- Its push level set to `input-only` through Push notifications.
- `audience: "person"` in Generative UI's metadata (`genui`), so the Captain gets GenUI's instructions and `check_ui`. It is written before the first message is sent: the thread spawns with that message held, then it is sent. Plugin start re-marks every live Captain. Crew threads are never marked.
- The Implement and Review presets in Tasks, when missing.

Rerunning `new` with a live Captain's name converges that Captain instead of starting a second one.

## Sidebar icon

The thread is titled with the Captain's name alone; its sidebar icon marks it as a Captain. A Captain shows the declared `captain/captain` glyph until it gets its own icon: a name from bb's built-in icon set (Hugeicons-style names such as `Star`, `Target` or `Brain`), or a picture. Set a name with `bb captain icon` or in Captain settings (Captain icons); set a picture only in settings. `--clear`, or Use default, goes back to the glyph. It is stored in `data.db`, so it survives a reload and a restart; archiving a Captain deletes it.

- **Names:** bb gives plugins no list of its icons. Settings draws the typed name and refuses one bb has no icon for ("Unknown icon"). The CLI stores a name unchecked and says so; a name bb lacks draws the default glyph.
- **Pictures:** settings decodes the upload in the browser (PNG, JPEG, GIF, WebP or SVG), crops it to its centre square and re-encodes it as a PNG of at most 96x96 px and 16 KB, stepping down to 80, 64, 48 or 32 px when a detailed picture is too big. An SVG is first sized from its viewBox, so the whole drawing is kept. `setIcon` stores only such a PNG: it checks the signature, a header of at most 96x96 and the closing IEND chunk, and refuses anything else. The CLI sets names only and refuses a value that looks like a file.
- **Bad rows:** a stored icon that fails the contract reads as the default glyph, never a failed read.

gtd-sidebar reads it through the keyed `icons` RPC, one batched read over the rows the Captain plugin started. Every key gets an entry, null for a thread that is not a live Captain (an archived one), so that row keeps its globe. A row holds an empty lead while the read loads, and every row keeps its globe while Captain is disabled or the read fails.

Captains started before this were titled "<name> Captain". On plugin start each one still titled exactly that is renamed to its name, once; a title the user changed is left alone.

## Instructions

`configure` gives each thread its text from `instructions/`, which Agent Instructions → Plugin prompts can edit:

| Thread                                                | Gets                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Captain, by its metadata                            | `captain.md`, its Drive's skills index and `CAPTAIN.md`; the `captain-brief`, `captain-review-loop`, `captain-routines` and `captain-ship` skills |
| A child of a Captain                                  | `crew.md`, its role's contract, the Drive's `CREW.md` and `repos/<KEY>.md`; Review also gets the `captain-review-lenses` skill                    |
| A Merge or Dream thread, by `pluginMetadata { role }` | `crew.md` and `CREW.md`                                                                                                                           |
| Anything else                                         | Nothing                                                                                                                                           |

The output stays within bb's 32,768-character limit. Only Drive text is ever cut, and the cut ends with a marker.

## Requirements

- The Tasks plugin (`scott-tasks`) enabled. `new` and `repo add` refuse while it does not answer.
- Push notifications, optional: without it `new` warns and continues.
- bb's built-in Automations plugin, for routines. `routine add` refuses while it does not answer.
