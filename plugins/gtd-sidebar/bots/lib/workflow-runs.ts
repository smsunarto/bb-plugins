// BB workflow runs execute their agent calls as hidden threads spawned by the
// built-in "workflows" plugin. Each agent thread's lifecycle follows the
// conversation that started the run, and its fallback title names the run:
//   "[BB workflow <name> · run wfr_<uuid>..."
// The workflows plugin archives agent threads when they finish, so active
// hidden agent threads are exactly the live runs worth showing in the sidebar.
export const WORKFLOWS_PLUGIN_ID = "workflows";

export type WorkflowAgentStatus = "working" | "waiting" | "error" | "idle";

export interface WorkflowAgent {
  threadId: string;
  title: string;
  status: WorkflowAgentStatus;
  createdAt: number;
}
export interface WorkflowRun {
  /** Stable per owner and run: the run id prefix when present. */
  key: string;
  ownerThreadId: string;
  name: string;
  runId: string | null;
  status: WorkflowAgentStatus;
  startedAt: number;
  agents: WorkflowAgent[];
}

export interface WorkflowAgentThread {
  id: string;
  title: string | null;
  titleFallback: string | null;
  originPluginId: string | null;
  lifecycleOwnerThreadId: string | null;
  archivedAt: number | null;
  deletedAt?: number | null;
  createdAt: number;
  status: string;
  runtime?: { displayStatus?: string } | null;
  hasPendingInteraction?: boolean;
  queuedWork?: string;
}

const TITLE = /^\[BB workflow (.+?) · run (wfr_[0-9a-f-]+)/;
const IN_FLIGHT = new Set(["active", "pending", "provisioning", "starting", "stopping"]);
const RANK: Record<WorkflowAgentStatus, number> = { idle: 0, error: 1, working: 2, waiting: 3 };

export function parseWorkflowTitle(
  fallback: string | null,
): { name: string; runId: string | null } | null {
  const match = fallback ? TITLE.exec(fallback) : null;
  return match ? { name: match[1]!, runId: match[2]! } : null;
}

export function isWorkflowAgent(
  thread: Pick<WorkflowAgentThread, "originPluginId" | "lifecycleOwnerThreadId">,
): boolean {
  return thread.originPluginId === WORKFLOWS_PLUGIN_ID && Boolean(thread.lifecycleOwnerThreadId);
}

export function workflowAgentStatus(thread: WorkflowAgentThread): WorkflowAgentStatus {
  const runtime = thread.runtime?.displayStatus ?? thread.status;
  if (thread.hasPendingInteraction || runtime === "waiting-for-host") return "waiting";
  if (IN_FLIGHT.has(runtime) || IN_FLIGHT.has(thread.status)) return "working";
  if (runtime === "error" || thread.status === "error" || thread.queuedWork === "failed")
    return "error";
  return "idle";
}

/** Group live (unarchived) workflow agent threads into runs per owning conversation. */
export function groupWorkflowRuns(threads: readonly WorkflowAgentThread[]): WorkflowRun[] {
  const runs = new Map<string, WorkflowRun>();
  for (const thread of threads) {
    if (!isWorkflowAgent(thread) || thread.archivedAt !== null || thread.deletedAt) continue;
    const owner = thread.lifecycleOwnerThreadId!;
    const parsed = parseWorkflowTitle(thread.titleFallback);
    const key = `${owner}:${parsed?.runId ?? parsed?.name ?? "workflow"}`;
    const status = workflowAgentStatus(thread);
    const agent: WorkflowAgent = {
      threadId: thread.id,
      title: thread.title ?? parsed?.name ?? "Workflow agent",
      status,
      createdAt: thread.createdAt,
    };
    const run = runs.get(key);
    if (run) {
      run.agents.push(agent);
      run.startedAt = Math.min(run.startedAt, thread.createdAt);
      if (RANK[status] > RANK[run.status]) run.status = status;
    } else {
      runs.set(key, {
        key,
        ownerThreadId: owner,
        name: parsed?.name ?? "Workflow",
        runId: parsed?.runId ?? null,
        status,
        startedAt: thread.createdAt,
        agents: [agent],
      });
    }
  }
  const result = [...runs.values()];
  for (const run of result)
    run.agents.sort((a, b) => a.createdAt - b.createdAt || a.threadId.localeCompare(b.threadId));
  return result.sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key));
}

export function workflowRunsByOwner(runs: readonly WorkflowRun[]): Map<string, WorkflowRun[]> {
  const byOwner = new Map<string, WorkflowRun[]>();
  for (const run of runs) {
    const list = byOwner.get(run.ownerThreadId) ?? [];
    list.push(run);
    byOwner.set(run.ownerThreadId, list);
  }
  return byOwner;
}

export function workflowRunSummary(run: WorkflowRun): string {
  // Finished agents are archived by the workflows plugin, so only live agents are known.
  const working = run.agents.filter(
    (agent) => agent.status === "working" || agent.status === "waiting",
  ).length;
  const total = run.agents.length;
  if (working) return `${working} running`;
  return `${total} ${total === 1 ? "agent" : "agents"}`;
}
