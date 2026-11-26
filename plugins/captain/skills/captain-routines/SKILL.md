---
name: captain-routines
description: Set, change, test, pause or remove a Captain routine, a message that wakes you on a schedule. Use when the user asks for recurring or later work, such as "every weekday at 9, sweep stalled crew" or "in two hours, check the deploy".
---

# Captain routines

A routine is a scheduled message to you. bb Automations holds the schedule; each run wakes this thread with the instruction, and you handle it as any wake. Set one only when the user asks in this thread.

## Built-in defaults

Every Captain starts with four daily routines in the bb server's time zone: **Backlog grooming** (`0 9 * * *`, 09:00), **Drive sweep** (`30 9 * * *`, 09:30), **Rebase crew work** (`0 10 * * *`, 10:00), and **Stuck crew cleanup** (`30 10 * * *`, 10:30). They are ordinary routines — pause, change, or remove them like any other, and a removed default never comes back.

## Set one up

1. Write the instruction to a file, such as `briefs/routine-<name>.md` in your Drive. Write it as a standalone request: what to do on each run and what to reply. Keep it under 4000 characters.
2. Add it with one schedule:
   - Recurring: `bb captain routine add --name "<name>" --cron "<cron>" --timezone <iana> --prompt-file <path>`. Ask the user's time zone when you do not know it; the default is the bb server's.
   - Once: `--in 2h`, or `--at <ISO time with offset>`, in place of `--cron`.
3. Tell the user the schedule in words and the next run, as `add` printed them.
4. Run it once with `bb captain routine run <id>`. The test wakes you with `· test`; handle it as a real run, since it does real work.

Done when the routine is listed in `bb captain routine list`, the user has its schedule in words, and its test run reached you.

## Change or stop one

- `bb captain routine update <id-or-name>` with `--name`, `--cron`, `--timezone`, `--in`, `--at` or `--prompt-file`. Repeat the new schedule in words.
- `bb captain routine pause|resume|remove <id-or-name>`. `show <id> --runs` lists its last runs: `sent`, `queued`, `skipped` or `failed`.

## Limits

- At most 20 routines per Captain. A cron runs at most every 15 minutes: each run is a turn of yours.
- A new routine waits for its next time. A time missed while bb was down runs once, late.
- A run that finds the previous one still queued behind your turn is skipped, shown as `skipped: previous run still queued`.

## Examples

Weekdays at 09:00, `--cron "0 9 * * 1-5"`, named **Stalled crew sweep**:

> In a background subagent, run `bb captain status --all`. Nudge each crew thread stalled over two hours with `bb captain tell --stalled`. For a thread blocked on an interaction for over an hour, check that it is in Needs you. For any task whose review passed at a full recorded head and that has no ship ask for that head, open or answered Merge or Hold, open one with `bb captain verdict <task> review passed --head <recorded sha> --ship --reason "<ship path and branch>"`; a Superseded ask does not count. Reply with one line; if nothing needed doing, say only that.

Mondays at 10:00, `--cron "0 10 * * 1"`, named **Stale PR check**:

> For each repo of this Captain, list open PRs from this Captain's crew that are over seven days without an update, failing CI, or conflicted. For one tied to an open task, dispatch Implement on that task to rebase or fix. Put the rest in one ask: Close or Keep. Never close or merge a PR yourself.

Fridays at 16:00, `--cron "0 16 * * 5"`, named **Friday cleanup and digest**:

> Archive crew threads whose task is done or canceled and whose final report you have read. Update `NOTES.md` with the plan as it stands. Reply with five lines at most: shipped, in review, blocked, waiting on the user.

Once, `--in 2h`: "Check whether BBP-41's PR merged; if not, say why."
