<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# Notify

**Real macOS notifications — bb's icon, bb's name, and a click that opens the thread.**

![bb ≥ 0.36](https://img.shields.io/badge/bb-%E2%89%A5%200.36-88C0D0?style=flat-square)
![macOS](https://img.shields.io/badge/platform-macOS-3FA266?style=flat-square)
![desktop app](https://img.shields.io/badge/needs-bb%20window-F1B467?style=flat-square)

</div>

<div align="center">
<picture><img src="docs/media/hero.png" alt="A macOS notification from bb: the thread name in bold, the project in brackets, and bb's own icon" width="620" /></picture>
</div>

Native macOS notifications when a bb thread finishes or fails, plus a
`notify_user` tool for agents and a `bb notify` command for you or a script.

The notification arrives with bb's own icon and name. Click it to open the
thread it came from.

## Install

**From the marketplace** — add this repository once, then install by name:

```sh
bb marketplace add git:github.com/smsunarto/bb-plugins
bb plugin install notify
```

bb resolves the newest `notify/vX.Y.Z` tag and builds the plugin from it against
your bb, so the bundle always matches the host it runs on. `bb plugin update
notify` follows the same release line. If another marketplace you have added
publishes a `notify`, spell it `notify@smsunarto`.

**From source** — clone the repo and install the plugin as a local path
source. This is also how you install a change that is not released yet:

```sh
git clone https://github.com/smsunarto/bb-plugins.git
cd bb-plugins
bun install
bun run --filter '@smsunarto/bb-plugin-notify' build
bb plugin install ./plugins/notify
```

The source path needs Bun and the `bb` CLI. It installs the plugin as a **local
path source**, so bb reads the files in place: edit, rebuild, reload, with no
reinstall.

The bb window asks for notification permission the first time it mounts. bb then
appears under **System Settings → Notifications**.

## Requirements

- **macOS.** The bb server and the bb desktop window must run on the same Mac.
- The bb desktop app with **at least one window open**. A headless bb queues
  notifications that nothing collects before they expire. Web browser tabs do
  not collect the desktop notification queue.
- Notification permission granted to bb.
- bb ≥ 0.36.

## What fires a notification

| Source | Trigger | Opens |
|---|---|---|
| `thread.idle` | A thread finished its turn | That thread |
| `thread.failed` | A thread errored | That thread |
| `notify_user` tool | An agent decides you need to know now | The agent's thread |
| `bb notify send` | You or a script | The thread the command ran in — `--thread <id>` overrides |

A successful turn does not spend a line saying "finished". Only a failure earns
words, as `Failed — <error>`.

## Commands

```sh
bb notify status                            # is a window listening, and the filters
bb notify test                              # post a sample notification
bb notify send "Build is green" --title CI
bb notify send "Ready" --thread thr_abc123  # open a thread other than this one
```

`send` takes `--flag value` or `--flag=value`, and `--` ends the flags. It
refuses a misspelled flag, and refuses a `--thread` value that is not a thread
id.

```console
$ bb notify status
window:     listening (1 polling)
held:       0
on idle:    true
on failed:  true
children:   false
hidden:     false
min run:    0s
sound:      off
agent tool: disabled
```

## Agent tool

`notify_user` takes one parameter, `message`, and posts a notification titled
with the thread and tagged with the project. It is off by default. Turn it on
with:

```sh
bb plugin config notify set agentTool true
```

## Settings

`bb plugin config notify set <key> <value>` — changes apply live, no reload.

| Key | Default | Meaning |
|---|---|---|
| `notifyOnIdle` | `true` | Notify when a thread finishes |
| `notifyOnFailed` | `true` | Notify when a thread fails |
| `includeChildThreads` | `false` | Include subagent threads |
| `includeHiddenThreads` | `false` | Include hidden plugin worker threads |
| `minRunSeconds` | `0` | Skip threads that finished faster than this. Capped at 30 days |
| `sound` | `off` | `off`, `system default`, or a named macOS tone |
| `agentTool` | `false` | Offer the `notify_user` tool to agents |

The defaults are the quiet ones: a notification arrives silently, and no agent
can interrupt you until you turn the tool on.

### Sound

| Choice | Notification | Tone |
|---|---|---|
| `off` | silent | none |
| `system default` | audible | macOS picks |
| `Ping`, `Glass`, … | silenced | `/System/Library/Sounds/<name>.aiff` |

A named tone silences the notification, so macOS does not stack its own default
underneath the chosen one. The server plays one tone for each acknowledged
batch.

## Behaviour worth knowing

- **Quiet by default.** Child threads (subagents) and hidden threads (plugin
  workers) are skipped. Two events about one thread inside 3 seconds collapse
  into the first. A turn you stopped with the stop button produces no
  notification.
- **Nothing is lost while bb is closed.** With no bb window open, a notification
  waits in a durable queue and appears when one opens. It survives plugin
  reloads and server restarts, and expires after 10 minutes.
- **Every completed turn can alert.** Notifications use a unique system tag, so
  a later turn from the same thread does not become a history-only replacement
  for an earlier macOS notification.
- **Markdown is flattened.** A notification body is plain text, so formatting is
  reduced to the words it decorated.

## Troubleshooting

**Nothing arrives.** Run `bb notify test`. If it reports `Held — no BB window is
open`, open a bb window. If it reports `Queued`, but no notification shows,
check **System Settings → Notifications → bb**.

**`bb notify` is not a command.** The command appears only after the plugin
installs and loads. Run `bb plugin list` to confirm that `notify` is there.

**Too many notifications.** Raise `minRunSeconds` to skip short turns, or set
`notifyOnIdle` to `false` to keep only the failures.

**The same notification shows twice.** Delivery is at least once. A window that
displays a notification and closes before it acknowledges the item can show that
item again after the 30-second lease expires.

## Develop from source

Install from source as shown under [Install](#install), then check a change
with:

```sh
bun run --filter '@smsunarto/bb-plugin-notify' typecheck
bun run --filter '@smsunarto/bb-plugin-notify' test
```

The test script needs Node 22.6+.
