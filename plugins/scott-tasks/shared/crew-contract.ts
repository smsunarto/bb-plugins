import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { idSchema, TASK_STATUSES, TASK_THREAD_LIVE_STATUSES } from "./contract";

// RPCs other plugins call: owned fields and the crew read. The app never imports
// this file, so these schemas stay out of the app bundle.

export const FIELD_TOKEN_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const fieldTokenSchema = z
  .string()
  .regex(
    FIELD_TOKEN_PATTERN,
    "must be lowercase letters, digits and dashes, start with a letter, and contain at most 32 characters",
  );
const threadIdSchema = z.string().startsWith("thr_");
export const CREW_SNAPSHOT_MAX_THREADS = 500;

const fieldDefinitionSchema = z
  .object({
    key: z.string(),
    ownerPluginId: z.string(),
    values: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;

const taskFieldValueSchema = z
  .object({
    key: z.string(),
    value: z.string(),
    /** What the value judged, such as a commit; opaque to Tasks. */
    head: z.string().nullable(),
    writtenAt: z.string(),
  })
  .strict();
export type TaskFieldValue = z.infer<typeof taskFieldValueSchema>;

/** Delivery of a notifying comment's wake line to the commenting thread's parent. */
const parentNotificationSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("pending"),
      targetThreadId: threadIdSchema.nullable(),
      attempts: z.number().int().nonnegative(),
      nextAttemptAt: z.string(),
      lastError: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      state: z.literal("delivered"),
      targetThreadId: threadIdSchema,
      attempts: z.number().int().positive(),
      deliveredAt: z.string(),
    })
    .strict(),
  z
    .object({
      state: z.literal("undeliverable"),
      targetThreadId: threadIdSchema.nullable(),
      attempts: z.number().int().nonnegative(),
      reason: z.string(),
    })
    .strict(),
]);
export type ParentNotification = z.infer<typeof parentNotificationSchema>;

const snapshotTaskSchema = z
  .object({
    id: idSchema,
    key: z.string(),
    title: z.string(),
    status: z.enum(TASK_STATUSES),
    statusChangedAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

/** One attached thread on one task, joined with what an orchestrator reads about it. */
const crewSnapshotRowSchema = z
  .object({
    threadId: threadIdSchema,
    presetName: z.string(),
    liveStatus: z.enum(TASK_THREAD_LIVE_STATUSES),
    liveStatusChangedAt: z.string(),
    attachedAt: z.string(),
    updatedAt: z.string(),
    task: snapshotTaskSchema,
    parentTask: snapshotTaskSchema.nullable(),
    fields: z.array(taskFieldValueSchema),
    /** This thread's latest comment on the task that notified its parent. */
    lastNotifyingComment: z
      .object({ id: idSchema, createdAt: z.string(), delivery: parentNotificationSchema })
      .strict()
      .nullable(),
  })
  .strict();
export type CrewSnapshotRow = z.infer<typeof crewSnapshotRowSchema>;

export const crewRpcContract = defineRpcContract({
  /** Define or update a field the calling plugin owns. Plugin callers only. */
  defineField: {
    input: z
      .object({
        key: fieldTokenSchema,
        values: z
          .array(fieldTokenSchema)
          .min(1)
          .max(32)
          .refine(
            (values) => new Set(values).size === values.length,
            "must not contain duplicates",
          ),
      })
      .strict(),
    output: z.object({ field: fieldDefinitionSchema }).strict(),
  },
  /** Set or unset (null) a task's value of a field the calling plugin owns. */
  setField: {
    input: z
      .object({
        taskId: idSchema,
        key: fieldTokenSchema,
        value: z.string().nullable(),
        head: z.string().trim().min(1).max(200).nullable().default(null),
      })
      .strict(),
    output: z
      .object({ field: taskFieldValueSchema.nullable(), taskUpdatedAt: z.string() })
      .strict(),
  },
  /** Each listed task's owned field values; tasks that do not exist are left out. */
  taskFields: {
    input: z.object({ taskIds: z.array(idSchema).min(1).max(CREW_SNAPSHOT_MAX_THREADS) }).strict(),
    output: z
      .object({
        tasks: z.array(
          z.object({ taskId: idSchema, fields: z.array(taskFieldValueSchema) }).strict(),
        ),
      })
      .strict(),
  },
  crewSnapshot: {
    input: z
      .object({
        threadIds: z.array(threadIdSchema).max(CREW_SNAPSHOT_MAX_THREADS),
        /** Only rows whose task, parent task, task-thread row or comments changed after this time. */
        changedSince: z.iso.datetime({ offset: true }).optional(),
      })
      .strict(),
    output: z.object({ rows: z.array(crewSnapshotRowSchema) }).strict(),
  },
});

export type CrewRpcContract = typeof crewRpcContract;
