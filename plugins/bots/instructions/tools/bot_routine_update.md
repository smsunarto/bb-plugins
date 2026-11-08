Create, change, pause, resume, test, or delete one of this bot's routines. A routine runs its instruction on a cron schedule, through bb Automations, in a subthread of the bot's main chat (one reused subthread, or a new one per run); bb reports each finished run to the main chat.

USE WHEN

- The user asks for something recurring ("every weekday at 9, summarize…", "check X every 2 hours"): action create.
- The user asks to edit, pause, resume, run now, or delete a routine.

BEFORE CALLING

- Get routineId from bot_routine_list for every action except create.
- Translate the user's schedule into a five-field cron and an IANA timezone. If the user has not given a timezone and none is known from memory or settings, ask once.
- Write the instruction as a standalone request: runs arrive without this conversation's context.

INPUTS

- create needs name, instruction, cron, and timezone. projectId defaults to this conversation's project when the routine may run there, else the bot's home project (listed as Home); bot_routine_list lists the allowed projects.
- execution sets the harness runs start on: providerId, model, and reasoningLevel (optional serviceTier), as listed by `bb provider models <provider> --json` for the bot's machine. A model or reasoning level that machine does not offer is rejected with the available ones. useDefaultModel true clears it, so runs use the bot's preferred model, else bb's default.
- threadMode reuse (the default) posts every run to the routine's one subthread, queued while it is busy. new starts a fresh subthread for each run; choose it for independent runs that should not share context.
- update takes routineId and only the fields that change. Moving to another project replaces the schedule, keeps it paused or active, and starts a new conversation in that project on the next run. Changing execution also starts a new conversation on the next run, because a thread keeps the harness it started on.
- Dr. Bot can pass bot (another bot's ID or name) to manage that bot's routines; routineId must belong to that bot.
- pause, resume, run, and delete take only routineId.

RETURNS
The routine with its automation state, or for delete `{ routine: null }`. run returns the Automations run record, usually still `running`: Automations delivers the instruction in the background. bot_routine_list then shows lastRunStatus; succeeded means the instruction reached the routine's conversation, not that its work is finished. A new routine waits for its next scheduled time; offer run if the user wants to see it work now.

SIDE EFFECTS
create, update, pause, resume, and delete change the bot's schedule immediately; run starts real work. Delete removes the schedule and keeps the routine's past conversation. Confirm before delete.
