# Save this for later

The user invoked `/remind-me` because they want to remember work without doing it now. Save a durable reminder in the Remind Me plugin’s separate store, then stop.

## Choose what to capture

Use any text after the command as the focus. Otherwise, infer the most relevant unfinished action, unresolved decision, or follow-up from the recent conversation. Prefer work the user explicitly postponed. Combine closely related items into one task; avoid inventing a new backlog.

Do not investigate, implement, delegate, or resume the deferred work. Do not ask for confirmation when the conversation gives you enough context. If there is no identifiable subject, ask one short question instead of fabricating a task.

## Write a useful reminder

Give the reminder a short, action-oriented title and a concise Markdown description containing:

- **Context:** what prompted the task and why it matters
- **Next step:** the first concrete action the user can take when they return
- **Done when:** the intended outcome, or the decision to make
- **References:** relevant files, links, that help the user resume; the source thread is stored separately

Keep facts, suggestions, and unresolved questions distinct. Include constraints or known blockers only when they help the user resume. Never invent deadlines, priorities, findings, or commitments. A note or open question can use “Revisit…” or “Decide…” as its action.

## Save in Remind Me

1. Run `bb remind-me rpc list` and reuse an existing reminder only if it captures the same deferred work completely. Reminders live in this plugin’s own database; do not create a BB task or a file in the repository.
2. Otherwise, generate a UUID once and save with `bb remind-me rpc save '<JSON>'`. The JSON fields are `id` (that UUID), `title`, `body` (the Markdown description), and `sourceThreadId` (the current `thr_...` ID, or null if unavailable). Use `bb status` to identify the current thread when needed. Construct JSON with proper shell quoting or invoke the CLI through an argument array; never interpolate conversation text into shell code. Keep the same ID and payload when retrying an uncertain save. Reusing an ID with different content is rejected.
3. Read it back with `bb remind-me rpc get '{"id":"<saved-id>"}'` and confirm the title and body persisted. If saving or verification fails, include the complete reminder in your reply and clearly say it could not be confirmed saved. Never claim persistence without a successful result.

## Confirm and stop

Reply with one sentence describing what was saved and a reminder card on its own line:

```md
::reminder{id="<saved-uuid>"}
```

The card and Reminders panel have an Add to composer button on hover or keyboard focus (always visible on touch). It appends the saved note to the draft without sending it or removing the reminder. The Reminders page opens the new-thread composer; the panel beside a conversation uses that conversation’s composer.

This command records work for later. It does not schedule a notification. Do not claim an alert was scheduled, start another agent, or continue the captured work.
