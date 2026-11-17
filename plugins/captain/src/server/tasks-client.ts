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

const presetSchema = z.object({ id: z.string(), name: z.string() });
export type TasksPreset = z.infer<typeof presetSchema>;

/** Tasks did not answer, or refused: the message says which. */
export class TasksError extends Error {}

export type TasksClient = ReturnType<typeof createTasksClient>;

export function createTasksClient(
  bb: Pick<BbPluginApi, "sdk">,
  deadlineMs: number = TASKS_DEADLINE_MS,
) {
  async function call<T>(method: string, input: unknown, outputSchema: z.ZodType<T>): Promise<T> {
    try {
      return await bb.sdk.plugins.callRpc({
        pluginId: TASKS_PLUGIN_ID,
        method,
        input: input as never,
        outputSchema,
        signal: AbortSignal.timeout(deadlineMs),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError"
          ? `no answer in ${deadlineMs / 1000}s`
          : error instanceof Error
            ? error.message
            : String(error);
      throw new TasksError(`Tasks ${method} failed: ${reason}`, { cause: error });
    }
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
    async createPreset(spec: PresetSpec): Promise<TasksPreset> {
      return (await call("createPreset", { ...spec }, z.object({ preset: presetSchema }))).preset;
    },
  };
}
