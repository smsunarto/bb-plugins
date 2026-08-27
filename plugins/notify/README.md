<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# Notify

**macOS notifications from BB, even after you close every BB window.**

![bb 0.40+](https://img.shields.io/badge/bb-0.40%2B-88C0D0?style=flat-square)
![macOS](https://img.shields.io/badge/platform-macOS-3FA266?style=flat-square)
![server only](https://img.shields.io/badge/BB%20window-not%20required-F1B467?style=flat-square)

</div>

Notify posts a macOS notification when a BB thread finishes or fails. It also
adds a `notify_user` agent tool and a `bb notify` command.

The plugin calls macOS Notification Center from the BB server process. It does
not need a BB window, a browser bridge, an HTTP listener, or a delivery queue.

## Install

Add this repository once, then install Notify:

```sh
bb marketplace add git:github.com/smsunarto/bb-plugins
bb plugin install notify
```

To install an unreleased source change:

```sh
git clone https://github.com/smsunarto/bb-plugins.git
cd bb-plugins
bun install
bun run --filter '@smsunarto/bb-plugin-notify' build
bb plugin install ./plugins/notify
```

## Requirements

- macOS.
- The BB server that runs Notify must run on the Mac receiving the alert.
- Notification permission for the macOS script host.
- BB 0.40 or newer.

Closing every BB window with `Cmd+W` does not quit BB on macOS. The owned server
continues to run, so Notify can still post alerts. `Cmd+Q` quits BB and its
owned server. Notify cannot post after that process stops.

macOS may attribute these alerts to Script Editor instead of BB. Alerts do not
open a BB thread when clicked. Those behaviors require BB Desktop to own the
native notification.

## Notification sources

| Source           | Trigger                               | Title context                      |
| ---------------- | ------------------------------------- | ---------------------------------- |
| `thread.idle`    | A thread finishes its turn            | Thread and project                 |
| `thread.failed`  | A thread fails                        | Thread and project                 |
| `notify_user`    | An agent decides you need to know now | Agent thread and project           |
| `bb notify send` | You or a script sends a message       | Supplied title and project context |

A successful turn uses the agent's final text. A failure uses
`Failed — <error>`.

## Commands

```sh
bb notify status
bb notify test
bb notify send "Build is green" --title CI
bb notify send "Ready" --thread thr_abc123
```

`--thread` finds that thread's project label. It does not add a click action.
The command accepts `--flag value` and `--flag=value`. `--` ends the flags.

```console
$ bb notify status
delivery:   macOS Notification Center
on idle:    true
on failed:  true
children:   false
hidden:     false
min run:    0s
sound:      off
agent tool: disabled
```

## Agent tool

`notify_user` takes one `message` parameter. It is off by default. Enable it
with:

```sh
bb plugin config notify set agentTool true
```

## Settings

Run `bb plugin config notify set <key> <value>`. Changes apply without a reload.

| Key                    | Default | Meaning                                            |
| ---------------------- | ------- | -------------------------------------------------- |
| `notifyOnIdle`         | `true`  | Notify when a thread finishes                      |
| `notifyOnFailed`       | `true`  | Notify when a thread fails                         |
| `includeChildThreads`  | `false` | Include subagent threads                           |
| `includeHiddenThreads` | `false` | Include hidden plugin worker threads               |
| `minRunSeconds`        | `0`     | Skip shorter runs. The maximum is 30 days          |
| `sound`                | `off`   | Use `off`, `system default`, or a named macOS tone |
| `agentTool`            | `false` | Offer `notify_user` to agents                      |

Notify is quiet by default. It skips child and hidden threads, suppresses a turn
you stopped manually, and collapses duplicate events for three seconds.

## Delivery behavior

- Notify posts once. It does not save, retry, lease, acknowledge, or replay an
  alert.
- Closing all windows does not affect delivery while the BB server still runs.
- Quitting BB stops an owned server. Events that happen after shutdown cannot
  notify.
- Notification bodies are plain text. Notify removes common Markdown syntax.

## Troubleshooting

**Nothing arrives.** Run `bb notify test`. If it fails, inspect the Notify log
with `bb plugin logs notify`. If it succeeds, check macOS notification settings
for the script host.

**`bb notify` is not a command.** Run `bb plugin list` and confirm that `notify`
is installed and loaded.

**Too many notifications.** Increase `minRunSeconds`. Disable
`notifyOnIdle` to keep only failures.

## Develop from source

Run the focused checks from the repository root:

```sh
bun run --filter '@smsunarto/bb-plugin-notify' typecheck
bun run --filter '@smsunarto/bb-plugin-notify' test
```

The test script needs Node 22.6 or newer.
