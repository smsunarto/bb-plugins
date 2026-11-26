# Tasks

Tasks is a Linear-style tracker inside bb for planning work, delegating it to
agents, and keeping the task record connected to the threads doing the work.
It provides projects and folders, task keys, statuses and priorities, labels,
subtasks, Markdown comments, attachments, agent presets, and a full CLI.

This fork is published as `@smsunarto/bb-plugin-scott-tasks` with plugin ID
`scott-tasks`. bb reserves the built-in's `tasks` ID, so the fork cannot reuse
it. Both claim the `bb tasks` command, so disable the built-in before enabling
the fork.

Forked from [`get-bb/bb/plugins/tasks`](https://github.com/get-bb/bb/tree/desktop-v0.44.0/plugins/tasks).
Last synced with upstream `main` at `b0ddaad731565d7e4de68d824120d802fc78f7d5`
on 2026-11-26, whose latest Tasks change is
[#7968](https://github.com/get-bb/bb/pull/7968) (`041f71314435ab617487edc265e906169aca15ee`).
Every upstream Tasks change since the previous base (`48c3a784`, 2026-11-18) is
ported or covered, except these:

Held on purpose:

- [#4464](https://github.com/get-bb/bb/pull/4464) (lifecycle without polling):
  the fork keeps its thread-status reconcile loop. The host fixes #4464
  relied on shipped in bb 0.45, so porting it is now a choice, not a wait.
- [#6419](https://github.com/get-bb/bb/pull/6419) (shared live reads) and
  [#7610](https://github.com/get-bb/bb/pull/7610), which tunes its query hook:
  the fork reads through its own TanStack Query and DB layer
  (`shell/collections.ts`, `shell/sync.ts`). That layer already batches card
  metadata, shares rows between views, and repaints a cached list scope at
  once. #4600 and #5261's signal scheduler are superseded by the same layer.
- [#5275](https://github.com/get-bb/bb/pull/5275): confirmations stay on the
  fork's shadcn `AlertDialog` (`components/confirm-dialog.tsx`) instead of
  bb's `ConfirmDeleteDialog`.
- [#4606](https://github.com/get-bb/bb/pull/4606) is ported only in part. Its
  blanked `is_image` migration already ran here. Fork tests still use
  `displayWidth` and the description saver's `schedule` option.

Held for a newer bb / Plugin SDK (live bb `0.50.1` runs `@get-bb/plugin-sdk`
`0.6.157`):

- [#7786](https://github.com/get-bb/bb/pull/7786) (`cb14a40d`): requires
  `experimental_matchesShortcutKey` (`bbPluginSdk >=0.6.160`).
- [#7749](https://github.com/get-bb/bb/pull/7749) (`53cb9701`): requires
  `experimental_thread.settled` and the server spawn event-ordering gate
  (`bbPluginSdk >=0.6.160`).
- [#7875](https://github.com/get-bb/bb/pull/7875) (`bce7015f`): requires
  `experimental_BbHttpError` and server-branded SDK errors
  (`bbPluginSdk >=0.6.167`).
- [#8047](https://github.com/get-bb/bb/pull/8047) (`1c8e7434`): requires
  `PluginMentionSearchContext.experimental_signal` (`bbPluginSdk >=0.6.183`).
- [#7956](https://github.com/get-bb/bb/pull/7956) (`29173ce7`): requires
  `PluginCommandRegistration.experimental_keyScope: "pluginPage"`
  (`bbPluginSdk >=0.6.183`).

The fork also fixes three bugs from upstream's incremental loading
([#4442](https://github.com/get-bb/bb/pull/4442)):

- A late partial result no longer clears a failed load.
- A task signal after a failed initial load triggers a refetch.
- `boardMove` publishes every card a column renumber touches, so the board
  keeps the server order.

The list, board, task detail, and project navigation are fork-specific UI.
When syncing upstream Tasks, port fixes to those views into the fork's layout
and preserve the existing task linking and agent dispatch integrations.

## Install

Install the fork from a checkout of this repository:

```sh
bb plugin disable tasks
bb plugin install /path/to/bb-plugins/plugins/scott-tasks --yes
```

The plugin adds the Tasks sidebar panel, the `bb tasks` command, and an agent
skill that teaches workers how to report progress back to tasks.

## Quick start

Install the plugin as shown above. Then use the `bb tasks` CLI
to create a tracker project. Link it to the bb project where delegated agents
will run:

```sh
bb tasks project create \
  --name "Product" \
  --prefix PROD \
  --link-bb-project proj_your_bb_project

bb tasks create \
  --project PROD \
  --title "Ship task delegation" \
  --description "Implement the flow and run focused validation." \
  --priority high

bb tasks list --project PROD
bb tasks show PROD-1
bb tasks preset list
bb tasks delegate PROD-1 --preset "GPT-5.6 · high"
```

An agent that dispatches its own crew adds `--parent-thread "$BB_THREAD_ID"`
so bb reports the child's turns to it, `--parent-notifications stuck` to hear
only when the child needs help, and `--base-branch <branch>` to start the
child's worktree from a branch other than the preset's.

When the CLI runs inside a linked bb project, `create` and `list` infer the
tracker project, so `--project` can be omitted. Task keys are case-insensitive
at the CLI boundary. You can also delegate from a task's **Delegate** menu,
choose or create presets under **Manage → Presets**, and type `@` in the bb
composer to send a task mention to an agent.

The comment composer shows a **Notify last responding agent** switch. When the
task has an agent reply, leave it on to send the new comment to the thread that
authored the latest reply, resuming that thread when it is idle. Turn it off to
keep the comment in Tasks only. If no agent has replied, the disabled control
says so explicitly. Agents and scripts can use the same behavior with
`bb tasks comment PROD-1 --body "New context" --notify`.
When run from a thread, the CLI preserves that agent thread and any explicit
`--author`; notification still targets the prior latest responder rather than
the newly recorded agent comment itself.

A child thread reports to its orchestrating parent with
`bb tasks comment PROD-1 --notify-parent --attach ./report.md --body-file report.txt`.
Tasks saves the comment and its files, then wakes the commenting thread's parent
with one line: `[tasks] PROD-1 <first line> · <thread> <preset> · <attachment ids and names>`.
A failed wake is retried after 1, 2, 5 and 15 minutes, then every 15 minutes, up
to six attempts in all; the comment is then marked undeliverable. A parent that
is missing, archived or deleted marks it undeliverable at once. Delivery state
lives in the database, so retries survive a plugin reload.

## CLI reference

Run `bb tasks --help` or `bb tasks <command> --help` for exact options; help
works at every level, lists each option's accepted values and limits, and exits 0. Unknown commands and options are rejected with the nearest real name, every
missing required value is reported in one error, and a failing invocation that
carries `--json` prints `{ "ok": false, "error": { "code", "message", "hint"? } }`
on stdout while stderr keeps the readable text. Add `--json` to commands when
another command or agent will consume the output.

`--project` takes a tracker project prefix or id such as `PROD`, never a bb
project id (`proj_...`); `bb tasks project list` shows both columns. Repeatable
options (`--label`, `--status`, `--priority`, `--add-label`, `--remove-label`)
also accept one comma-separated list. File paths (`--file`, `--attach`,
`--out`, `--description-file`, `--body-file`) resolve on the invoking machine:
inside an agent thread that is the thread's machine. Outside a thread, pass
`--machine <id-or-name>` to name the enrolled machine that owns the paths,
unless only one machine is enrolled. `--machine` for a machine other than the
thread's needs absolute paths.

| Command                                        | Purpose                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bb tasks status`                              | Show the installed Tasks plugin name and version. Task workflow status lives on `bb tasks list --status` and `bb tasks update --status`.                      |
| `bb tasks project create\|list\|show\|update`  | Manage tracker projects, folders, colors, prefixes, and bb-project links.                                                                                     |
| `bb tasks folder create\|list\|update\|delete` | Organize tracker projects into nested folders. Deleting a folder moves its projects and subfolders to the top level; no tasks are deleted.                    |
| `bb tasks create`                              | Create a task with description, priority, labels, due date, optional parent, and file attachments (repeatable `--attach <path>`).                             |
| `bb tasks list`                                | Page/filter tasks by project, status, priority, label, active agents, or search text; supports `--sort`, `--limit`, and `--cursor`.                           |
| `bb tasks show <key-or-id>`                    | Show the complete task record, including comments, attachments, subtasks, and attached threads.                                                               |
| `bb tasks update <key-or-id>`                  | Update status, priority, title, description, due date, or labels.                                                                                             |
| `bb tasks move <key-or-id>`                    | Move a task and its sub-tasks to `--project`. Moved tasks get new keys; old keys keep resolving, and labels are matched by name.                              |
| `bb tasks comment <key-or-id>`                 | Add a Markdown comment from text or a file, with `--attach` files; `--notify` reaches the latest agent, `--notify-parent` wakes this thread's parent.         |
| `bb tasks attachment add\|get\|list\|remove`   | Add, fetch, list, or remove attachments. Referenced attachments require `remove --remove-references`.                                                         |
| `bb tasks preset list\|create\|update\|delete` | Manage reusable agent execution presets.                                                                                                                      |
| `bb tasks delegate <key>`                      | Start and attach a new agent thread using a preset; `--parent-thread`, `--parent-notifications` and `--base-branch` make it a child thread on its own branch. |
| `bb tasks attach <key-or-id>`                  | Attach the current bb thread to a task when it was not delegated from Tasks.                                                                                  |
| `bb tasks detach <key-or-id>`                  | Detach the current bb thread (or `--thread <id>`) from a task, for example a dead predecessor after a respawn.                                                |
| `bb tasks threads <key>`                       | List the bb threads attached to a task: live threads first, newest first.                                                                                     |
| `bb tasks label create\|list\|delete`          | Manage project-scoped labels.                                                                                                                                 |
| `bb tasks seed-demo --yes`                     | Create sample folders, projects, labels, tasks, and comments for evaluation.                                                                                  |

Statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`, and
`canceled`. Priorities are `urgent`, `high`, `medium`, `low`, and `none`.

Task lists default to 100 rows and accept `--limit 1-500`. JSON output is
`{ tasks, nextCursor, limit }`; human output prints the continuation option
when another page exists. The cursor is opaque and tied to the filters, sort,
and current task-list revision. If tasks are added, removed, reordered, or
updated between requests—or label links/names, active task threads, or project
prefixes change—the old cursor is rejected. Restart from the first page rather
than traversing an inconsistent snapshot.

## Agents, delegation, and presets

Linking a Tasks project to a bb project enables delegation. Open a task, choose
**Delegate**, select a preset, and optionally add instructions. A preset
defines the provider, model, reasoning level, optional service tier, permission
mode, and reusable instructions. Presets are user-defined, so create the worker profiles your team
uses repeatedly before dispatching work.

Delegation creates a worker thread in the linked bb project, attaches that
thread to the task, and advances a `backlog` or `todo` task to `in_progress`.
The worker receives the task description, subtasks, attachments, recent
comments, preset instructions, and a report-back contract. Its installed Tasks
skill tells it to inspect the task, leave substantive milestone comments,
attach artifacts, and move completed work to `in_review`. An orchestrating
plugin can pass its own `reportContract` to the `delegate` RPC; a dispatch with
`parentNotifications: "stuck"` and no contract gets none, because its parent
defines how to report.

Other plugins can also read and write through Tasks' plugin RPCs: owned fields
(`defineField`, `setField`, written only by the plugin that defined the field),
`crewSnapshot` (one read of the tasks, fields, live status and last notifying
comment of a set of threads), a `presetName` on `taskThreadsAttach`, and an
`author` and `agent` or `system` source on `createComment`.

If work begins outside the Delegate action, the agent can associate its current
thread with `bb tasks attach KEY`. The inverse is `bb tasks detach KEY
[--thread <id>]`, and each thread card on the task page has a detach control;
use either to drop a thread that died or moved on to other work. The task
page and `bb tasks threads` list live threads before completed or failed ones,
newest first. A thread's Info tab lists the tasks it is attached to;
select one to open it beside the thread.

## Task mentions

Type `@` in the bb composer and select **Tasks** to search by task key or title.
Sending the mention gives the agent the task's description, status, priority,
labels, subtasks, attachments, recent comments, attached threads, and CLI
action contract as context. Tasks linked to the current bb project rank first.

Inside a task description or comment, `@` also inserts a task pill. These
references are stored in Markdown as `[PROD-1](bbtask://PROD-1)`, so they remain
portable in task content.

Mentioning a task key such as `PROD-1` in an agent request also activates the
Tasks skill, which directs the worker to read and update the tracked task.

## Known limitations

- The **Auto** delegation preset is deferred; choose an explicit preset.
- List filters are local UI state and are not persisted in the URL.

## Fast follow

- Batch task-list enrichment for comments and attached-thread state.
- Add notifications and an inbox for task activity.
- Add a command palette entry for Tasks to cmd-K.
