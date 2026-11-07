import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BOT_TAGS } from "../contract.ts";
import {
  groupWorkflowRuns,
  isWorkflowAgent,
  WORKFLOWS_PLUGIN_ID,
  type WorkflowAgentThread,
  type WorkflowRun,
} from "./workflow-runs.ts";

const EVENTS = [
  "thread.created",
  "thread.active",
  "thread.idle",
  "thread.failed",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
] as const;

/**
 * Live BB workflow runs, read from the workflows plugin's hidden agent threads.
 * Owners receive `onOwnerActivity` when a run starts or progresses so completed
 * conversations reopen while their workflows are working.
 */
export function createWorkflowRuns(
  bb: BbPluginApi,
  onOwnerActivity: (ownerThreadId: string) => void = () => {},
) {
  async function list(): Promise<WorkflowRun[]> {
    const threads: WorkflowAgentThread[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await bb.sdk.threads.list({
        archived: false,
        includeHidden: true,
        originPluginId: WORKFLOWS_PLUGIN_ID,
        offset,
        limit: 100,
      });
      threads.push(...page);
      if (page.length < 100) break;
    }
    return groupWorkflowRuns(threads);
  }

  /** Conversations with a live run: completion treats them as busy. */
  async function busyOwners(): Promise<Set<string>> {
    try {
      return new Set(
        (await list()).filter((run) => run.status !== "idle").map((run) => run.ownerThreadId),
      );
    } catch (error) {
      bb.log.warn(
        `Could not read workflow runs: ${error instanceof Error ? error.message : String(error)}`,
      );
      return new Set();
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const publishSoon = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      bb.rpc.experimental_invalidate([BOT_TAGS.workflowRuns]);
    }, 250);
  };
  for (const event of EVENTS) {
    bb.events.on(event, ({ thread }: { thread: WorkflowAgentThread }) => {
      if (!isWorkflowAgent(thread)) return;
      if (event === "thread.created" || event === "thread.active")
        onOwnerActivity(thread.lifecycleOwnerThreadId!);
      publishSoon();
    });
  }

  return { list, busyOwners };
}
