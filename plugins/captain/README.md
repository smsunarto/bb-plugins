# Captain

A Captain is a long-lived bb thread that runs other threads for you. You hand it work in plain words; it briefs crew threads, checks what they report, and tells you only what needs you.

A thread can be a Captain, with its own rules, Drive and repos, and it runs crew on Tasks: dispatch, verdicts, tells, asks and status (build steps 2 to 4 of the Captain spec). A background check wakes a Captain once per crew thread that stays stalled for 15 minutes and retries undelivered answers.

Each role starts crew on a model ladder set in Captain settings (Crew models): ordered provider, model and reasoning rungs, Codex after the role's own preset by default. Dispatch takes the first rung whose provider has a ready Account Pooler account for that model family, read from the pool's `status.get`. A crew thread that fails on a rate limit bb will not retry, before it reports, is restarted on the next eligible rung and archived, and the Captain gets one wake line. After the last rung the wake says Blocked. Each rung runs through a Tasks preset Captain owns, such as `Captain Review · 2`, copied from the shared `Review` preset; Captain never changes the shared presets other dispatches use. The Needs you banner arrives in a later step.

```sh
bb captain new --name Plugins --repo bb-plugins [--repo rampage] [--prompt-file purpose.md]
bb captain repo add rampage [--tasks RAMP]
bb captain repo remove RAMP
bb captain drive read CREW.md
bb captain drive write NOTES.md --file ./notes.md
bb captain archive

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
bb captain status [--since <cursor>] [--all]
```

Long text goes through a file on the calling machine (`--message-file`, `--detail-file`). The stdin flags (`--message-stdin`, `--detail-stdin`) take one line only, as every bb plugin CLI stdin flag does.

Run `bb captain --help` for every option. Every command takes `--json`.

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
- **Away pause:** when no client has opened a Captain for 7 days and a routine reached it on its schedule since, the maintenance service pauses its running routines and opens one ask, "Routines paused while you were away". **Resume** restarts exactly those; **Keep paused** leaves them. Only the user or that Captain may answer it. A failed step is retried on the next pass.
- The Captain's Overview tab gains a Routines section in a later step.

## What `new` sets up

- A Claude Code thread on the bb server's machine, pinned, in the shared **Captains** project (`~/Captains`), carrying `pluginMetadata { captain: { name } }`.
- Empty `CAPTAIN.md`, `CREW.md` and `NOTES.md` in its thread storage, the Drive. They are created only when missing, so a rerun never overwrites them.
- A linked Tasks project for each repo, linking the one already linked to that bb project or creating one.
- Its push level set to `input-only` through Push notifications.
- `audience: "person"` in Generative UI's metadata (`genui`), so the Captain gets GenUI's instructions and `check_ui`. It is written before the first message is sent: the thread spawns with that message held, then it is sent. Plugin start re-marks every live Captain. Crew threads are never marked.
- The Plan, Implement and Review presets in Tasks, when missing.

Rerunning `new` with a live Captain's name converges that Captain instead of starting a second one.

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
