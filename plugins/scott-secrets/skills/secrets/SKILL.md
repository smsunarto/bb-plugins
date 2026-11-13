---
name: secrets
description: "Request user-supplied credentials securely into a dotenv file, or run a command with sudo after the user approves it, without exposing values to the agent."
---

# Request secrets securely

Use `bb secret request` when the user needs to supply a credential. Do not ask the user to paste a secret into chat.

Batch every currently known variable into one request. Inspect documentation or `.env.example` to identify variable names, but do not read or print an existing secret-bearing env file.

```bash
bb secret request OPENAI_API_KEY RESEND_API_KEY \
  --purpose "Configure application credentials" \
  --describe OPENAI_API_KEY "OpenAI API key used by the server" \
  --describe RESEND_API_KEY "Resend API key used for transactional email" \
  --write-env .env.local
```

Always provide the exact `--write-env` destination, a concise purpose, and one short plain-language description per variable. Relative destinations resolve from the CLI working directory; absolute destinations may point anywhere on the thread's host. Never place secret values in argv, prompts, comments, logs, or follow-up messages.

The command blocks until the user submits or cancels the form. Secret values
never appear in command arguments, model-visible output, or persisted
interaction data. After success, trust the command's path, variable names, and
added/updated/unchanged counts. Never verify by running `cat`, `sed`, `env`, or another command that would reveal the completed file.

If the command reports duplicate dotenv assignments, fix the file structure without reading values and rerun the request. If it reports repeated write conflicts, rerun the same request; do not ask the user to paste values. Under the workspace sandbox (Accept Edits / Approve for me), Claude's macOS sandbox permits the loopback access plugin CLI commands need; Linux and other provider sandboxes may still require escalation approval.

## Run a command as root

When `sudo -n <command>` fails because a password is required, run the command through `bb secret sudo` instead. Do not request `SUDO_PASSWORD` into a dotenv file.

```bash
bb secret sudo --purpose "Install the PostgreSQL client" -- pacman -S --noconfirm postgresql-libs
```

- Put the whole command after `--`, as separate arguments. There is no shell: for pipes, redirection, or several steps, write `-- sh -c '…'`, and keep that script short enough for the user to read.
- Give one `--purpose` line that says why the command needs root.
- The first request in a thread shows the user the exact command, its working directory, and the host, and asks for the password. Later requests from the same thread run without a form until the cache window (15 minutes by default, fixed from when the password was typed) ends. The password stays in memory on the thread's host and is never written to disk or shown to you.
- The command runs non-interactively: its stdin is closed, so a prompt reads end-of-file and usually aborts. Pass flags such as `--noconfirm` or `-y`. `--timeout` (default 600 seconds) ends a command that runs too long.
- The call blocks while the user decides, then while the command runs. Give your shell tool a timeout longer than both, or run it in the background; a shell timeout that cuts the CLI off abandons the request.
- The CLI exits with the command's exit code and prints its stdout and stderr. Each stream is captured up to 4 MiB.
- Run one command per meaningful step, even when no form appears. Do not batch unrelated root changes into one `sh -c`, and tell the user what you ran as root in your reply.
- Never answer a sudo form yourself with `bb thread interactions respond` or any other API. Approval must come from the user.

Errors:

- `sudo_request_denied`: the user declined the password form. Do not retry the same command; ask what they want instead.
- `sudo_auth_failed`: sudo rejected the password, and nothing ran. Rerun once so the user can type it again. Stop and tell the user if it fails again, since repeated failures can lock the account.

`bb secret forget-sudo` drops this thread's cached password. Run it when the user asks, or after a sensitive task the user wants closed off.
