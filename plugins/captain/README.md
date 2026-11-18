# Captain

A Captain is a long-lived bb thread that runs other threads for you. You hand it work in plain words; it briefs crew threads, checks what they report, and tells you only what needs you.

A thread can be a Captain, with its own rules, Drive and repos, and it runs crew on Tasks: dispatch, verdicts, tells, asks and status (build steps 2 to 4 of the Captain spec). A background check wakes a Captain once per crew thread that stays stalled for 15 minutes and retries undelivered answers.

Each role starts crew on a model ladder set in Captain settings (Crew models): ordered provider, model and reasoning rungs, Codex after the role's own preset by default. Dispatch takes the first rung whose provider has a ready Account Pooler account for that model family, read from the pool's `status.get`. A crew thread that fails on a rate limit bb will not retry, before it reports, is restarted on the next eligible rung and archived, and the Captain gets one wake line. After the last rung the wake says Blocked. Rung n > 1 runs through its own Tasks preset, `Review · 2`. The Needs you banner arrives in a later step.

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

| Thread                                                | Gets                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A Captain, by its metadata                            | `captain.md`, its Drive's skills index and `CAPTAIN.md`; the `captain-brief`, `captain-review-loop` and `captain-ship` skills  |
| A child of a Captain                                  | `crew.md`, its role's contract, the Drive's `CREW.md` and `repos/<KEY>.md`; Review also gets the `captain-review-lenses` skill |
| A Merge or Dream thread, by `pluginMetadata { role }` | `crew.md` and `CREW.md`                                                                                                        |
| Anything else                                         | Nothing                                                                                                                        |

The output stays within bb's 32,768-character limit. Only Drive text is ever cut, and the cut ends with a marker.

## Requirements

- The Tasks plugin (`scott-tasks`) enabled. `new` and `repo add` refuse while it does not answer.
- Push notifications, optional: without it `new` warns and continues.
