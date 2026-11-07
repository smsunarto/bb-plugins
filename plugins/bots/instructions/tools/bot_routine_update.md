Create, change, pause, resume, test, or delete one of this bot's routines. A routine runs its instruction on a cron schedule, through bb Automations, in a conversation of its own; each run posts its result there.

USE WHEN
- The user asks for something recurring ("every weekday at 9, summarize…", "check X every 2 hours"): action create.
- The user asks to edit, pause, resume, run now, or delete a routine.

BEFORE CALLING
- Get routineId from bot_routine_list for every action except create.
- Translate the user's schedule into a five-field cron and an IANA timezone. If the user has not given a timezone and none is known from memory or settings, ask once.
- Write the instruction as a standalone request: runs arrive without this conversation's context.

INPUTS
- create needs name, instruction, cron, and timezone. projectId defaults to this conversation's project when the routine may run there, else Personal; bot_routine_list lists the allowed projects.
- update takes routineId and only the fields that change. Moving to another project replaces the schedule, keeps it paused or active, and starts a new conversation in that project on the next run.
- pause, resume, run, and delete take only routineId.

RETURNS
The routine with its automation state, or for delete `{ routine: null }`. run returns the Automations run record, usually still `running`: Automations delivers the instruction in the background. bot_routine_list then shows lastRunStatus; succeeded means the instruction reached the routine's conversation, not that its work is finished. A new routine waits for its next scheduled time; offer run if the user wants to see it work now.

SIDE EFFECTS
create, update, pause, resume, and delete change the bot's schedule immediately; run starts real work. Delete removes the schedule and keeps the routine's past conversation. Confirm before delete.
