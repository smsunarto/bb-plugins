# Grok Bot

Control a Grok Bot from bb. A **Grok Bot** page in the navigation rail sends a
message or a ping to one Grok Bot webhook, with an optional target bot. Inside a
thread, the side panel's **Send to Grok Bot** action sends the same request with
that thread's context attached. The page shows whether each send succeeded and
keeps a log of recent sends.

The webhook URL and key stay on the bb server. The browser only learns whether
the config file is usable and which bots it lists.

## What it sends

Each send is one `POST` to the configured URL, with an 8-second timeout and no
retries:

```http
POST <url>
Content-Type: application/json
Authorization: Bearer <key>
X-Automation-Key: <key>

{
  "action": "message",
  "target_bot": "research",
  "text": "Summarize the open review comments",
  "context": { "thread_id": "thr_abc123", "project": "bb-plugins", "branch": "scott/feature" },
  "ts": "2026-11-02T10:04:00.000Z"
}
```

- `action` is `"message"` or `"ping"`. A ping sends `"text": "ping"`.
- `target_bot` is a bot `id` from the config, or `null` to let the router decide.
- `context` is present only for **Send to Grok Bot** in a thread or `bb grokbot send --thread`.
  `project` is the bb project name; `branch` is the thread environment's branch, or `null`.
- `ts` is the send time in ISO 8601 UTC.

Any 2xx response counts as sent. A non-2xx status, a timeout, a network error,
or a redirect counts as failed. Redirects are not followed, so the key is never
sent to a second address.

## Configure

Create `~/.config/bb-grokbot/config.json` on the machine that runs the bb
server. The `umask 077` subshell creates the directory and file readable only by
you before the key is written. Paste it into `sh`, `bash` or `zsh`; fish has no
heredocs, so run `sh` first there:

```sh
(
  umask 077
  mkdir -p ~/.config/bb-grokbot
  touch ~/.config/bb-grokbot/config.json
  chmod 600 ~/.config/bb-grokbot/config.json
  cat > ~/.config/bb-grokbot/config.json <<'EOF'
{
  "url": "https://grok-bot.example/hooks/bb",
  "key": "<automation key>",
  "bots": [
    { "id": "research", "name": "Research bot" },
    { "id": "ops" }
  ]
}
EOF
)
```

- `url` (required): the webhook, `https://` or `http://`. Over plain `http://`
  the key travels unencrypted, so use it only on loopback or an encrypted
  network such as a tailnet.
- `key` (required): sent as both `Authorization: Bearer` and `X-Automation-Key`.
  It must be visible ASCII with no spaces, as HTTP headers require.
- `bots` (optional): the **Target bot** dropdown. `name` defaults to `id`. Omit
  it, or leave it empty, to send `target_bot: null` every time.

The plugin rereads the file on each send, so edits apply without a reload. If
the file is missing, is not valid JSON, lacks a usable `url` or `key`, or can be read by
group or others, the page shows **Not configured** with the reason and
disables sending. Set `BB_GROKBOT_CONFIG` in the bb server's environment to use
another path, for example in a test instance.

## Ping

**Ping** on the page, or from a terminal:

```sh
bb grokbot ping            # prints e.g. "Sent ping: HTTP 200 in 35ms"
bb grokbot ping --bot ops  # ping a specific target
bb grokbot ping --json     # {outcome: {ok, status, error, durationMs}, entry, logged}
```

The command exits 0 on a 2xx response and 1 otherwise.

## Other commands

```sh
bb grokbot status                          # is the config usable, and which bots
bb grokbot send "Deploy finished" --bot ops
bb grokbot send "Review this" --thread here  # attach the calling thread's context
bb grokbot log --limit 50                  # recent sends, newest first
```

## Send log

The plugin keeps the last 200 sends in bb's own database (`bb.db` in the bb
server's data directory), under this plugin's key-value key `send-log`. Each
entry records the time, action, target bot, the first 200 characters of the
text, the thread context, and the outcome: success, HTTP status, error, and
duration. It never records the webhook URL or the key. Read it on the Grok Bot
page or with `bb grokbot log`.
