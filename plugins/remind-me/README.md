# Save work for later

Type `/remind-me` in a BB conversation to ask the agent to save the relevant unfinished work in BB Tasks. Add a hint, such as `/remind-me revisit the retry edge case`, to narrow the subject.

The agent records the context, next step, completion criteria, and source thread. It reuses an existing task for the same work or creates a backlog task, then replies with a task card. It does not start the work or schedule a notification.

Requires BB Tasks (`bb tasks`). If saving is unavailable, the agent returns the reminder text and explains that it was not saved.

The user-only slash command is declared in `skills/remind-me/SKILL.md`. `bb remind-me prompt` reads `instructions/remind-me.md` on each invocation, so its workflow can be edited in Prompt Editor. The plugin uses `@bb-kit/core` and BB's native skill discovery; it has no separate task store or UI.
