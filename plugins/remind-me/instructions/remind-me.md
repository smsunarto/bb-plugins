# Save this for later

The user invoked `/remind-me` because they want to remember work without doing it now. Capture a durable task in BB Tasks, then stop.

## Choose what to capture

Use any text after the command as the focus. Otherwise, infer the most relevant unfinished action, unresolved decision, or follow-up from the recent conversation. Prefer work the user explicitly postponed. Combine closely related items into one task; avoid inventing a new backlog.

Do not investigate, implement, delegate, or resume the deferred work. Do not ask for confirmation when the conversation gives you enough context. If there is no identifiable subject, ask one short question instead of fabricating a task.

## Write a useful reminder

Give the task a short, action-oriented title and a concise Markdown description containing:

- **Context:** what prompted the task and why it matters
- **Next step:** the first concrete action the user can take when they return
- **Done when:** the intended outcome, or the decision to make
- **References:** relevant files, links, and the source thread as `@thread:<thread-id>` when available

Keep facts, suggestions, and unresolved questions distinct. Include constraints or known blockers only when they help the user resume. Never invent deadlines, priorities, findings, or commitments. A note or open question can use “Revisit…” or “Decide…” as its action.

## Save in BB Tasks

1. Read the Tasks skill and `bb tasks create --help`. Run `bb tasks project list --json` to find the tracker project matching this conversation. Use `bb status` for the current BB project and thread when needed. The `--project` flag takes a tracker prefix or ID, not a `proj_...` ID. Prefer the matching linked project; if several match, use the name and conversation scope. Ask only if the destination remains ambiguous.
2. Search that project's open tasks with `bb tasks list --project <prefix> --status backlog,todo,in_progress,in_review --search <keywords> --json`. Reuse a task only when it describes the same deferred work. Add missing context as a comment without overwriting its description or resetting its status. Read the task first. If an earlier save had an uncertain result, check for it before retrying. Follow `nextCursor` when the search has more results.
3. Otherwise, create one task with `bb tasks create --project <prefix> --title <title> --description-file <absolute-path> --json`. Write the description to a temporary UTF-8 file on the invoking machine using safe quoting. Leave the task in `backlog`, with priority `none` and no due date unless the user supplied one. The create command defaults to those values; verify the returned record. Do not attach a worker or mark it in progress.
4. Read the saved task with `bb tasks show <key> --json` and confirm its title and description persisted. If Tasks is unavailable, no matching project exists, or saving fails, keep the complete reminder in the reply and clearly say it was not saved. Never claim persistence without a successful result.

## Confirm and stop

Reply with one sentence describing what was saved and a task card on its own line:

```md
::task{key="<saved-task-key>"}
```

This command records work for later. It does not schedule a notification. Do not claim an alert was scheduled, start another agent, or continue the captured work.
