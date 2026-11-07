List this bot's routines: scheduled instructions that run in their own conversation. Returns each routine's id, name, instruction, cron, timezone, projectId, and threadId (null until its first run), plus automation state (enabled, nextRunAt, lastRunAt, lastRunStatus, lastError) and the projects a routine may run in.

Call it before bot_routine_update to get a routineId, when the user asks what routines exist or when one runs next, and before creating a routine to avoid a duplicate. An automationError means the schedule could not be read; report it instead of guessing the state.
