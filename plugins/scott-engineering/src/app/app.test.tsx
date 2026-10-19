import { expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import { runSchema, type ArenaRun } from "../shared/arena.ts";

installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent, act } = await import("@testing-library/react");

const id = "0dd8112b-dd33-41ee-a6ca-a0ecf025cd75";
function fixture(): ArenaRun {
  const model = {
    providerId: "codex",
    model: "codex",
    reasoningLevel: "xhigh",
    serviceTier: "fast",
  };
  const job = {
    key: "candidate",
    round: 1,
    role: "candidate",
    candidate: 0,
    model,
    dispatch: "started",
    threadId: "worker",
    environmentId: "environment",
    path: "/work/candidate",
    commit: "a".repeat(40),
    report: {
      kind: "candidate",
      summary: "Keep cancellation under one owner",
      tradeoff: "Small API with explicit ownership",
    },
    outcome: "completed",
    error: null,
    retried: false,
  };
  return runSchema.parse({
    version: 1,
    id,
    requestId: "request",
    task: "Make cancellation reliable",
    parentThreadId: "parent",
    projectId: "project",
    environmentId: "environment",
    hostId: "host",
    root: "/work/source",
    base: "a".repeat(40),
    models: [model, model],
    lead: model,
    round: 1,
    phase: "candidates",
    jobs: [job],
    integration: null,
    error: null,
    startedAt: 0,
    updatedAt: 0,
  });
}

async function mount() {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const directive = app.messageDirectives[0];
  if (!directive) throw new Error("Arena directive is not registered");
  const state: {
    run: ArenaRun;
    stops: number;
    reads: number;
    stopResponse?: Promise<{ run: ArenaRun }>;
  } = { run: fixture(), stops: 0, reads: 0 };
  const slot = renderSlot(
    directive,
    {
      attributes: { run: id },
      source: `::arena{run="${id}"}`,
      message: { id: "message", threadId: "parent", projectId: "project", turnId: null },
      openWorkspaceFile: null,
    },
    {
      pluginId: "scott-engineering",
      rpc: {
        get: () => {
          state.reads += 1;
          return { run: state.run };
        },
        stop: () => {
          state.stops += 1;
          if (state.stopResponse) return state.stopResponse;
          state.run = { ...state.run, phase: "stopped" };
          return { run: state.run };
        },
      },
    },
  );
  await slot.findByRole("article", { name: "Arena run summary" });
  return { state, slot };
}

test("the embed shows a candidate TL;DR and Stop Arena cancels independently", async () => {
  const { state, slot } = await mount();
  try {
    expect(slot.getByText("Keep cancellation under one owner")).toBeTruthy();
    expect(slot.getByText("Round 1 of 3")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Open Candidate 1 thread" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "worker" }]);
    fireEvent.click(slot.getByRole("button", { name: "Stop Arena" }));
    await slot.findByText("Stopped");
    expect(state.stops).toBe(1);
    expect(slot.queryByRole("button", { name: "Stop Arena" })).toBeNull();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("realtime completion replaces progress with synthesis and verification", async () => {
  const { state, slot } = await mount();
  try {
    const candidate = state.run.jobs[0];
    if (!candidate) throw new Error("Missing candidate fixture");
    state.run = {
      ...state.run,
      phase: "completed",
      jobs: [
        ...state.run.jobs,
        {
          ...candidate,
          key: "synthesis",
          candidate: null,
          role: "synthesis",
          report: {
            kind: "synthesis",
            summary: "One owner, clearer errors",
            baseCandidate: 0,
            rationale: "The simpler boundary won",
            grafts: [{ candidate: 1, change: "Better failure messages" }],
            checks: [{ command: "bun test", exitCode: 0, output: "Passed" }],
            rejected: ["A second cancellation registry"],
          },
        },
      ],
      integration: {
        status: "integrated",
        summary: "Verified and integrated",
        checks: [{ command: "bun test", exitCode: 0, output: "All checks passed" }],
      },
    };
    await slot.behavior.emitRealtime("arena.changed", { runId: id });
    await slot.findByText("One owner, clearer errors");
    expect(slot.getByText("Integrated")).toBeTruthy();
    expect(slot.getByText("From Candidate 2: Better failure messages")).toBeTruthy();
    expect(slot.getByText("Passed")).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Stop Arena" })).toBeNull();
    const reads = state.reads;
    await slot.behavior.emitRealtime("arena.changed", {
      runId: "7ba0d685-1655-4dfc-8e44-16d5fdd87984",
    });
    expect(state.reads).toBe(reads);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("reconnecting refreshes a completion missed while disconnected", async () => {
  const { state, slot } = await mount();
  try {
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    state.run = { ...state.run, phase: "completed" };
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("Integrated");
    expect(slot.queryByRole("button", { name: "Stop Arena" })).toBeNull();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a delayed Stop response cannot replace a newer stopped state", async () => {
  const { state, slot } = await mount();
  try {
    let finish: ((value: { run: ArenaRun }) => void) | undefined;
    state.stopResponse = new Promise((resolve) => {
      finish = resolve;
    });
    fireEvent.click(slot.getByRole("button", { name: "Stop Arena" }));
    const delayed = { ...state.run, phase: "stopping" as const, updatedAt: 1 };
    state.run = { ...state.run, phase: "stopped", updatedAt: 2 };
    await slot.behavior.emitRealtime("arena.changed", { runId: id });
    await slot.findByText("Stopped");
    await act(async () => {
      finish?.({ run: delayed });
    });
    expect(slot.getByText("Stopped")).toBeTruthy();
    expect(slot.queryByText("Stopping")).toBeNull();
  } finally {
    slot.lifecycle.unmount();
  }
});
