# bb-plugin-notify

Native notifications for BB on macOS, posted by BB.

BB notifies *agents* — a parent thread hears about its children, a workflow
reports back into its origin thread — but it never notifies the *person*. This
plugin closes that gap: a native notification when a thread finishes or fails,
a `notify_user` tool agents can call, and a `bb notify` command.

## One path

macOS credits a notification to the process that posted it. The only process
that can post as BB is BB, so the plugin posts from the app window: a content
script long-polls the plugin's own HTTP route and calls the web `Notification`
API, which Electron turns into a native notification owned by BB. The supported
topology is deliberately local: the BB server and desktop window run on the
same Mac.

```
server                                      BB window
  thread.idle ──▶ durable queue ◀── GET /pending (leased)
                       │                       │
                       │                       └──▶ new Notification(…) ──▶ macOS, as BB
                       │                                      │
                       └──────── remove ◀────────── POST /ack ┘
```

There is no notifier setting, because there is no second notifier worth
offering. osascript and terminal-notifier were both built and both removed:
each can only ever arrive as the interpreter — Script Editor's icon, no click
target — and an alternative that is worse in every respect is not a choice, it
is a trap. **With no BB window open, a notification waits in the durable queue
and appears when one opens**, surviving plugin reloads and server restarts. It
expires after 10 minutes because news that old is no longer news.

Delivery is at least once. A batch remains leased until the window confirms
that it constructed each notification; a dropped response or renderer reload
therefore retries instead of losing the batch. A renderer that displays a
notification and closes before acknowledging it can cause the same item to be
shown again after the 30-second lease expires.

## Shape

```
BB notification support                      ← thread (bold title)
[git] Root cause: macOS credits the poster.  ← project, then what happened
```

The thread identifies the notification, so it takes the title — the one line
macOS renders in bold. The project is context rather than news, so it rides in
front of the message as a bracketed tag: there when the eye looks for it, out
of the way when it does not.

With no project the message stands alone rather than carrying empty brackets.

A successful turn does not spend a line saying "finished": arriving at all is
the signal. Only a failure earns words, as `Failed — <error>`.

**Markdown is flattened.** A notification body is plain text — macOS has no
renderer for it — so `**Root cause:** …` would otherwise be displayed with its
asterisks showing. Emphasis, code, links, headings, bullets, and quotes are
reduced to the words they decorate:

```
**Root cause: the trick cannot work.** See `format.ts` for [details](url).
→ Root cause: the trick cannot work. See format.ts for details.
```

`snake_case`, `2 * 3`, and backslash-escaped markers survive intact.

## Clicking opens the thread

The click routes through `bb.sdk.threads.open` — the same action behind
`bb thread open` — so BB resolves the project, picks the pane, and focuses the
window. Guessing a URL from a thread id could not do any of that.

Every notification carries its own thread automatically:

| Source | Opens |
|---|---|
| Thread event | The thread that finished or failed |
| `notify_user` | The thread the agent is running in |
| `bb notify send` | The thread the command ran in — `--thread <id>` overrides |

`notify_user` takes only a message. It has no title parameter, so it is titled
with the thread and tagged with the project like every other notification — an
agent-chosen headline would make one row of the list look unlike all the
others, and it is information the reader already has.

The fallbacks (sidebar row, then a URL) apply only when the request never
reached the server. A thread the server actively declines to open — deleted,
bad id — navigates nowhere rather than guessing.

## What fires a notification

| Source | Trigger |
|---|---|
| `thread.idle` | A thread finished its turn |
| `thread.failed` | A thread errored |
| `notify_user` tool | An agent decides you need to know now |
| `bb notify send` | You or a script |

Child threads (subagents) and hidden threads (plugin workers) are skipped by
default because they are noisy. Two events about one thread inside 3 seconds
collapse into the first.

## Install

```sh
bb plugin install ./plugins/notify --yes
bb notify test
```

The BB window asks for notification permission the first time the content
script mounts. BB then appears under System Settings → Notifications.

## Commands

```sh
bb notify status                 # is a window listening, and the filters
bb notify test                   # post a sample notification
bb notify send "Build is green" --title "CI"
bb notify send "Ready" --thread t_abc123   # open a thread other than this one
```

`send` takes `--flag value` or `--flag=value`, and `--` ends the flags. It
refuses a misspelled flag rather than silently eating the word after it, and
refuses a `--thread` value that is not a thread id rather than posting a
notification whose click can land nowhere.

## Settings

`bb plugin config notify set <key> <value>` — changes apply live, no reload.

| Key | Default | Meaning |
|---|---|---|
| `notifyOnIdle` | `true` | Notify when a thread finishes |
| `notifyOnFailed` | `true` | Notify when a thread fails |
| `includeChildThreads` | `false` | Include subagent threads |
| `includeHiddenThreads` | `false` | Include hidden plugin worker threads |
| `minRunSeconds` | `0` | Skip threads that finished faster than this; capped at 30 days |
| `sound` | `off` | `off`, `system default`, or a macOS tone |
| `agentTool` | `false` | Offer the `notify_user` tool to agents |

Both defaults are the quiet ones: a notification arrives silently, and no
agent can interrupt you until you turn the tool on.

### Sound

The web Notification API has one sound control, `silent` — it cannot name a
tone. So the dropdown resolves three ways:

| Choice | Notification | Tone |
|---|---|---|
| `off` | silent | none |
| `system default` | audible | macOS picks |
| `Ping`, `Glass`, … | silenced | `afplay /System/Library/Sounds/<name>.aiff` |

A named tone silences the notification so macOS does not stack its own default
underneath the chosen one. The name is matched against the known list rather
than escaped, so no setting string reaches the filesystem. The server plays one
tone after the window acknowledges a displayed batch, so a notification held
while BB was closed does not chime into an empty room and a batch does not
launch overlapping sounds. This relies on the supported same-Mac topology.

`minRunSeconds` only applies when the plugin saw the thread start. A thread
already running when the plugin loaded always notifies.

## Limits

- **Local macOS only.** The BB server and desktop window must run on the same
  Mac. Remote enrolled hosts, browser-only clients, and split server/renderer
  machines are outside this plugin's support contract.
- **A headless BB never notifies.** Delivery needs a desktop app window. A
  server-only BB queues notifications that nothing will collect before they
  expire.
- **No focus detection.** The plugin cannot tell whether you are already
  looking at the thread, so it notifies either way. Use `minRunSeconds` to cut
  the short turns you were clearly watching.

## Layout

| File | Role |
|---|---|
| `server.ts` | Settings, events, agent tool, CLI, queue and routes |
| `app.tsx` | Content script that posts the notification from the BB window |
| `format.ts` | Pure text, argument, and filter helpers |
| `queue.ts` | Durable queue, delivery leases, acknowledgement and expiry |
| `sound.ts` | The sound choices and how each is carried out |
| `test/` | `node --test` over the pure modules |

The queue is never drained merely because a window polled it. The server leases
a batch for 30 seconds and removes only the notification IDs the window
acknowledges. When a response is dropped or the window hangs up — a reload, a
close, a navigation — the lease expires and the batch becomes deliverable
again. The tone is played only after acknowledgement.

`app.tsx` is a content script rather than a slot component because that is the
only frontend surface mounted everywhere in the app. It has no React context,
hence the long-poll instead of the realtime hook, and a `navigator.locks` lease
so several open windows do not each post the same notification.
