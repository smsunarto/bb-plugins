import { afterEach, describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import {
  groupWorkflowRuns,
  parseWorkflowTitle,
  workflowRunSummary,
  type WorkflowAgentThread,
} from "../../bots/lib/workflow-runs";
import { backend, PERSONAL_ID, request } from "./backend-fixture";

const RUN = "wfr_a5537c09-6f10-47d5-bd1a-dd88d603a533";
function agent(id: string, overrides: Partial<WorkflowAgentThread> = {}): WorkflowAgentThread {
  return {
    id,
    title: `Research ${id}`,
    titleFallback: `[BB workflow category-investigation · run ${RUN.slice(0, 34)}...`,
    originPluginId: "workflows",
    lifecycleOwnerThreadId: "owner",
    archivedAt: null,
    deletedAt: null,
    createdAt: 10,
    status: "active",
    runtime: { displayStatus: "active" },
    hasPendingInteraction: false,
    queuedWork: "none",
    ...overrides,
  };
}

describe("workflow run grouping", () => {
  it("parses the workflow name and the (possibly truncated) run id from the fallback title", () => {
    expect(parseWorkflowTitle(`[BB workflow walgit-bazel · run ${RUN}]`)).toEqual({
      name: "walgit-bazel",
      runId: RUN,
    });
    expect(parseWorkflowTitle("[BB workflow a b · run wfr_1234-ab...")).toEqual({
      name: "a b",
      runId: "wfr_1234-ab",
    });
    expect(parseWorkflowTitle("Some chat")).toBeNull();
  });

  it("groups live agents per owner and run, ranks status, and ignores archived or foreign threads", () => {
    const runs = groupWorkflowRuns([
      agent("a", { createdAt: 12 }),
      agent("b", { createdAt: 11, status: "idle", runtime: { displayStatus: "idle" } }),
      agent("c", {
        hasPendingInteraction: true,
        status: "idle",
        runtime: { displayStatus: "idle" },
      }),
      agent("done", { archivedAt: 50 }),
      agent("chat", { originPluginId: "side-chat" }),
      agent("other", {
        createdAt: 20,
        lifecycleOwnerThreadId: "owner-2",
        titleFallback: "[BB workflow fixers · run wfr_99...",
        status: "error",
        runtime: { displayStatus: "error" },
      }),
    ]);
    expect(
      runs.map((run) => [
        run.ownerThreadId,
        run.name,
        run.status,
        run.agents.map((a) => a.threadId),
      ]),
    ).toEqual([
      ["owner", "category-investigation", "waiting", ["c", "b", "a"]],
      ["owner-2", "fixers", "error", ["other"]],
    ]);
    expect(workflowRunSummary(runs[0]!)).toBe("2 running");
    expect(workflowRunSummary(runs[1]!)).toBe("1 agent");
  });
});

const instances: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

describe("workflow runs on the server", () => {
  async function setup() {
    const host = await backend();
    instances.push(host);
    const bot = await host.create();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++)
      ids.push(
        (
          (await host.harness.behavior.callRpc("conversation_create", {
            botId: bot.id,
            request: request(PERSONAL_ID),
          })) as { threadId: string }
        ).threadId,
      );
    const old = Date.now() - 4 * 24 * 60 * 60 * 1000;
    ids.forEach((id, index) =>
      host.threads.set(id, {
        ...host.threads.get(id)!,
        createdAt: old + index,
        updatedAt: old + index,
        latestAttentionAt: old + index,
      }),
    );
    const [worker, main] = ids as [string, string];
    const workflowAgent = makeThreadResponse({
      id: "wf-agent",
      projectId: PERSONAL_ID,
      originPluginId: "workflows",
      lifecycleOwnerThreadId: worker,
      visibility: "hidden",
      title: "Research client-bot",
      titleFallback: `[BB workflow category-investigation · run ${RUN}`,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const completions = async () =>
      (
        (await host.harness.behavior.callRpc("bots_list", {})) as {
          completions: { threadId: string }[];
        }
      ).completions.map((row) => row.threadId);
    return { host, worker, main, workflowAgent, completions };
  }

  it("lists live runs from hidden workflow agent threads", async () => {
    const { host, worker, workflowAgent } = await setup();
    host.threads.set(workflowAgent.id, workflowAgent);
    const { runs } = (await host.harness.behavior.callRpc("workflow_runs", {})) as {
      runs: {
        ownerThreadId: string;
        name: string;
        status: string;
        agents: { threadId: string }[];
      }[];
    };
    expect(runs).toEqual([
      expect.objectContaining({
        ownerThreadId: worker,
        name: "category-investigation",
        status: "working",
        agents: [expect.objectContaining({ threadId: "wf-agent", title: "Research client-bot" })],
      }),
    ]);
  });

  it("never auto-completes a conversation while its workflow runs, and reopens it when a run starts", async () => {
    const { host, worker, workflowAgent, completions } = await setup();
    host.threads.set(workflowAgent.id, workflowAgent);
    await host.harness.behavior.runSchedule("auto-complete");
    expect(await completions()).not.toContain(worker);
    host.threads.delete(workflowAgent.id);
    await host.harness.behavior.runSchedule("auto-complete");
    expect(await completions()).toContain(worker);
    await host.harness.behavior.emitThreadEvent("thread.created", { thread: workflowAgent });
    expect(await completions()).not.toContain(worker);
  });
});
