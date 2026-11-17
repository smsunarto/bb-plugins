# Captain

A Captain is a long-lived bb thread that runs other threads for you. You hand it work in plain words; it briefs crew threads, checks what they report, and tells you only what needs you.

This is the plugin skeleton (build step 2 of the Captain spec): a thread can be a Captain, with its own rules, Drive and repos. Crew dispatch, verdicts, asks, status and the Needs you banner arrive in later steps.

```sh
bb captain new --name Plugins --repo bb-plugins [--repo rampage] [--prompt-file purpose.md]
bb captain repo add rampage [--tasks RAMP]
bb captain repo remove RAMP
bb captain drive read CREW.md
bb captain drive write NOTES.md --file ./notes.md
bb captain archive
```

Run `bb captain --help` for every option. Every command takes `--json`.

## What `new` sets up

- A Claude Code thread on the bb server's machine, pinned, in the shared **Captains** project (`~/Captains`), carrying `pluginMetadata { captain: { name } }`.
- Empty `CAPTAIN.md`, `CREW.md` and `NOTES.md` in its thread storage, the Drive. They are created only when missing, so a rerun never overwrites them.
- A linked Tasks project for each repo, linking the one already linked to that bb project or creating one.
- Its push level set to `input-only` through Push notifications.
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
