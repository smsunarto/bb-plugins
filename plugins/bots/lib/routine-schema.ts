import { z } from "zod";

/** Matches Grok Bot's per-bot cap. */
export const ROUTINES_PER_BOT = 50;
export const ROUTINE_NAME_MAX = 80;
export const ROUTINE_INSTRUCTION_MAX = 4000;

const id = z.string().min(1);
/** The harness a routine's runs start on; null uses the bot's preferred model, else bb's default. */
export const routineExecutionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    model: z.string().trim().min(1),
    reasoningLevel: z.string().trim().min(1),
    serviceTier: z.string().trim().min(1).optional(),
  })
  .strict();
export type RoutineExecution = z.infer<typeof routineExecutionSchema>;
/** reuse: every run posts to the routine's one subthread. new: each run starts its own. */
export const routineThreadModeSchema = z.enum(["reuse", "new"]);
export type RoutineThreadMode = z.infer<typeof routineThreadModeSchema>;
export const routineFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(ROUTINE_NAME_MAX),
    instruction: z.string().trim().min(1).max(ROUTINE_INSTRUCTION_MAX),
    cron: z.string().trim().min(1).max(100),
    timezone: z.string().trim().min(1).max(64),
    projectId: id,
    // Defaults keep routines saved before these fields existed valid.
    execution: routineExecutionSchema.nullable().default(null),
    threadMode: routineThreadModeSchema.default("reuse"),
  })
  .strict();
export type RoutineFields = z.infer<typeof routineFieldsSchema>;

export const routineSchema = routineFieldsSchema
  .extend({
    id,
    botId: id,
    /** The bb automation that schedules the routine; null only if it could not be recreated. */
    automationId: id.nullable(),
    /** The routine's conversation: its latest run's when threadMode is new. Created by the first run. */
    threadId: id.nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type Routine = z.infer<typeof routineSchema>;

export const routineViewSchema = routineSchema
  .extend({
    /** Live schedule state from Automations; null when it cannot be read. */
    automation: z
      .object({
        enabled: z.boolean(),
        nextRunAt: z.number().nullable(),
        lastRunAt: z.number().nullable(),
        lastRunStatus: z.string().nullable(),
        lastError: z.string().nullable(),
        runCount: z.number(),
      })
      .strict()
      .nullable(),
    automationError: z.string().nullable(),
  })
  .strict();
export type RoutineView = z.infer<typeof routineViewSchema>;

export const routineActionSchema = z.enum(["pause", "resume", "run", "delete"]);
export type RoutineAction = z.infer<typeof routineActionSchema>;

export const routineRunSchema = z
  .object({
    id,
    status: z.enum(["running", "succeeded", "failed", "skipped"]),
    trigger: z.enum(["schedule", "manual"]),
    error: z.string().nullable(),
    output: z.string().nullable(),
    startedAt: z.number(),
    finishedAt: z.number().nullable(),
  })
  .strict();
export type RoutineRun = z.infer<typeof routineRunSchema>;

/**
 * `bot_routine_update`'s input. Flat like `bot_update_state` so every provider
 * accepts the schema; `execute` checks which fields each action needs.
 */
export const routineToolSchema = z
  .object({
    action: z.enum(["create", "update", "pause", "resume", "run", "delete"]),
    routineId: id.nullish().describe("Required except for create. From bot_routine_list."),
    name: routineFieldsSchema.shape.name
      .nullish()
      .describe("Short label shown in the Routines list. Required for create."),
    instruction: routineFieldsSchema.shape.instruction
      .nullish()
      .describe("What to do on each run, as a standalone request. Required for create."),
    cron: routineFieldsSchema.shape.cron
      .nullish()
      .describe(
        "Five-field cron, for example 0 9 * * 1-5 for weekdays at 9:00. Required for create.",
      ),
    timezone: routineFieldsSchema.shape.timezone
      .nullish()
      .describe("IANA timezone for cron, for example America/Los_Angeles. Required for create."),
    projectId: id
      .nullish()
      .describe(
        "Project the routine's conversation runs in. Create defaults to this conversation's.",
      ),
    execution: routineExecutionSchema
      .nullish()
      .describe(
        "Harness for runs: providerId, model, and reasoningLevel from `bb provider models --json`. Omit to keep the current choice.",
      ),
    useDefaultModel: z
      .boolean()
      .nullish()
      .describe("true clears execution, so runs use the bot's preferred model or bb's default."),
    threadMode: routineThreadModeSchema
      .nullish()
      .describe(
        "reuse (default): every run posts to the routine's one subthread. new: each run starts a fresh subthread.",
      ),
  })
  .strict();
export type RoutineToolInput = z.infer<typeof routineToolSchema>;
