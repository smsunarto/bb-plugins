import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { PresetSpec } from "./roles.ts";

/**
 * The only module that calls `scott-tasks`. Each call is an HTTP request with
 * a deadline. The schemas name only the fields Captain reads and are not
 * strict, so fields Tasks adds later pass through.
 */

export const TASKS_PLUGIN_ID = "scott-tasks";
export const TASKS_DEADLINE_MS = 10_000;

export const TASKS_PREFIX = /^[A-Z][A-Z0-9]{0,9}$/u;
const DEFAULT_PROJECT_COLOR = "blue";

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  linkedBbProjectId: z.string().nullable(),
});
export type TasksProject = z.infer<typeof projectSchema>;

const presetSchema = z.object({
  id: z.string(),
  name: z.string(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  reasoningLevel: z.string().optional(),
  serviceTier: z.string().nullable().optional(),
  permissionMode: z.string().optional(),
  environmentKind: z.string().optional(),
  baseBranch: z.string().nullable().optional(),
  machineId: z.string().nullable().optional(),
  instructions: z.string().optional(),
});
export type TasksPreset = z.infer<typeof presetSchema>;

/** What `createPreset` takes: a role's spec, or a later rung copied from rung 1's preset. */
export type PresetInput = Omit<PresetSpec, "permissionMode" | "environmentKind"> & {
  permissionMode: string;
  environmentKind: string;
  serviceTier?: string | null;
  baseBranch?: string | null;
  machineId?: string | null;
  instructions?: string;
};

const taskSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  status: z.string(),
  updatedAt: z.string(),
});
export type TasksTask = z.infer<typeof taskSchema>;

const snapshotTaskSchema = taskSchema.extend({ statusChangedAt: z.string().optional() });
const fieldValueSchema = z.object({
  key: z.string(),
  value: z.string(),
  head: z.string().nullable(),
  writtenAt: z.string(),
});
export type TaskFieldValue = z.infer<typeof fieldValueSchema>;

/** One attached thread on one task, as `crewSnapshot` joins it. */
const crewRowSchema = z.object({
  threadId: z.string(),
  presetName: z.string(),
  liveStatus: z.string(),
  attachedAt: z.string(),
  updatedAt: z.string(),
  task: snapshotTaskSchema,
  parentTask: snapshotTaskSchema.nullable(),
  fields: z.array(fieldValueSchema),
  lastNotifyingComment: z
    .object({
      id: z.string(),
      createdAt: z.string(),
      delivery: z.object({ state: z.string(), reason: z.string().optional() }),
    })
    .nullable(),
});
export type CrewRow = z.infer<typeof crewRowSchema>;

/** Tasks' own cap on `crewSnapshot` thread ids per call. */
const SNAPSHOT_MAX_THREADS = 500;

/** Tasks did not answer, or refused: the message says which. */
export class TasksError extends Error {
  /** The deadline fired: Tasks may still have done the work. */
  readonly timedOut: boolean;
  constructor(message: string, options: { cause: unknown; timedOut: boolean }) {
    super(message, { cause: options.cause });
    this.timedOut = options.timedOut;
  }
}

/** bb's answer when a plugin's RPC schema refuses the input, before its handler runs. */
const INPUT_REFUSED = /rpc input validation failed/u;

function isInputRefusal(error: unknown): boolean {
  return error instanceof TasksError && !error.timedOut && INPUT_REFUSED.test(error.message);
}

export type TasksClient = ReturnType<typeof createTasksClient>;

export function createTasksClient(
  bb: Pick<BbPluginApi, "sdk">,
  deadlineMs: number = TASKS_DEADLINE_MS,
) {
  async function call<T>(method: string, input: unknown, outputSchema: z.ZodType<T>): Promise<T> {
    const signal = AbortSignal.timeout(deadlineMs);
    try {
      return await bb.sdk.plugins.callRpc({
        pluginId: TASKS_PLUGIN_ID,
        method,
        input: input as never,
        outputSchema,
        signal,
      });
    } catch (error) {
      // What callRpc rejects with on abort is unverified, so the signal decides.
      const timedOut = signal.aborted;
      const reason = timedOut
        ? `no answer in ${deadlineMs / 1000}s`
        : error instanceof Error
          ? error.message
          : String(error);
      throw new TasksError(`Tasks ${method} failed: ${reason}`, { cause: error, timedOut });
    }
  }

  /** Tasks' mutation envelope: `{ ok: false, error }` is a refusal, not a transport failure. */
  async function mutate(method: string, input: unknown): Promise<TasksTask> {
    const result = await call(
      method,
      input,
      z.union([
        z.object({ ok: z.literal(true), task: taskSchema }),
        z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) }),
      ]),
    );
    if (!result.ok) {
      throw new TasksError(`Tasks ${method} refused: ${result.error.message}`, {
        cause: result.error,
        timedOut: false,
      });
    }
    return result.task;
  }

  return {
    async listProjects(): Promise<TasksProject[]> {
      return (await call("listProjects", {}, z.object({ projects: z.array(projectSchema) })))
        .projects;
    },
    async createProject(input: {
      name: string;
      prefix: string;
      linkedBbProjectId: string;
    }): Promise<TasksProject> {
      return (
        await call(
          "createProject",
          { ...input, color: DEFAULT_PROJECT_COLOR },
          z.object({ project: projectSchema }),
        )
      ).project;
    },
    async linkProject(projectId: string, linkedBbProjectId: string): Promise<TasksProject> {
      return (
        await call(
          "updateProject",
          { projectId, linkedBbProjectId },
          z.object({ project: projectSchema }),
        )
      ).project;
    },
    async listPresets(): Promise<TasksPreset[]> {
      return (await call("listPresets", null, z.object({ presets: z.array(presetSchema) })))
        .presets;
    },
    async createPreset(spec: PresetInput): Promise<TasksPreset> {
      return (await call("createPreset", { ...spec }, z.object({ preset: presetSchema }))).preset;
    },
    /** Point a preset at another provider, model and reasoning; its other fields stay. */
    async updatePresetExecution(
      presetId: string,
      execution: {
        providerId: string;
        modelId: string;
        reasoningLevel: string;
        serviceTier: string | null;
      },
    ): Promise<TasksPreset> {
      return (
        await call("updatePreset", { presetId, ...execution }, z.object({ preset: presetSchema }))
      ).preset;
    },
    async getTaskByKey(taskKey: string): Promise<TasksTask | null> {
      return (await call("getTaskByKey", { taskKey }, z.object({ task: taskSchema.nullable() })))
        .task;
    },
    async updateTaskStatus(taskId: string, status: string, authorName: string): Promise<TasksTask> {
      return await mutate("updateTask", { taskId, status, authorName });
    },
    /**
     * Spawn a thread for a task through a preset; resolves once Tasks attached it.
     * A Tasks older than `senderThreadId` refuses the whole input before it
     * spawns anything, so that refusal is retried once without the sender.
     */
    async delegate(input: {
      taskId: string;
      presetId: string;
      parentThreadId: string;
      senderThreadId: string;
      parentNotifications: "stuck";
      reportContract: string;
      extraInstructions: string;
      baseBranch?: string;
    }): Promise<string> {
      const output = z.object({ threadId: z.string() });
      try {
        return (await call("delegate", input, output)).threadId;
      } catch (error) {
        if (!isInputRefusal(error)) throw error;
        const { senderThreadId: _sender, ...withoutSender } = input;
        return (await call("delegate", withoutSender, output)).threadId;
      }
    },
    /** One task's owned-field values; empty when the task has none or no longer exists. */
    async taskFields(taskId: string): Promise<TaskFieldValue[]> {
      const { tasks } = await call(
        "taskFields",
        { taskIds: [taskId] },
        z.object({
          tasks: z.array(z.object({ taskId: z.string(), fields: z.array(fieldValueSchema) })),
        }),
      );
      return tasks.find((row) => row.taskId === taskId)?.fields ?? [];
    },
    async attachThread(input: {
      taskId: string;
      threadId: string;
      presetName: string;
    }): Promise<void> {
      await call("taskThreadsAttach", input, z.object({ threadId: z.string() }));
    },
    /** Each thread's task rows, in calls of at most Tasks' cap; no call for no threads. */
    async crewSnapshot(threadIds: readonly string[], changedSince?: string): Promise<CrewRow[]> {
      const rows: CrewRow[] = [];
      for (let start = 0; start < threadIds.length; start += SNAPSHOT_MAX_THREADS) {
        const page = await call(
          "crewSnapshot",
          {
            threadIds: threadIds.slice(start, start + SNAPSHOT_MAX_THREADS),
            ...(changedSince === undefined ? {} : { changedSince }),
          },
          z.object({ rows: z.array(crewRowSchema) }),
        );
        rows.push(...page.rows);
      }
      return rows;
    },
    async defineField(key: string, values: readonly string[]): Promise<void> {
      await call("defineField", { key, values: [...values] }, z.object({ field: z.unknown() }));
    },
    async setField(input: {
      taskId: string;
      key: string;
      value: string;
      head: string | null;
    }): Promise<TaskFieldValue | null> {
      return (
        await call(
          "setField",
          input,
          z.object({ field: fieldValueSchema.nullable(), taskUpdatedAt: z.string() }),
        )
      ).field;
    },
    /** A comment that reads as the Captain's own: an agent comment from its thread. */
    async createComment(input: {
      taskId: string;
      body: string;
      author: string;
      threadId: string;
    }): Promise<{ id: string }> {
      return (
        await call(
          "createComment",
          { ...input, notify: false, source: "agent" },
          z.object({ comment: z.object({ id: z.string() }) }),
        )
      ).comment;
    },
    async listComments(
      taskId: string,
    ): Promise<{ id: string; body: string; authorName: string }[]> {
      return (
        await call(
          "listComments",
          { taskId },
          z.object({
            comments: z.array(
              z.object({ id: z.string(), body: z.string(), authorName: z.string() }),
            ),
          }),
        )
      ).comments;
    },
  };
}
