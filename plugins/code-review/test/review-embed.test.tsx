import "./dom.ts";
import { beforeEach, expect, test } from "bun:test";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { timeoutManager } from "@tanstack/react-query";
import { branchReviewRange } from "../src/shared/schema.ts";
import { rpc } from "../src/app/rpc.ts";
import { localBranch, localBranches, localChanges, pullRequest } from "./app-fixtures.ts";

const { fireEvent, waitFor } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

beforeEach(() => pluginQueryClient.clear());

async function card(
  attributes: Record<string, string>,
  paths: string[] = [],
  overrides: Record<string, (input: never) => unknown> = {},
) {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = app.messageDirectives.find((each) => each.id === "code-review");
  if (!directive) throw new Error("No code-review directive");
  return renderSlot(
    directive,
    {
      attributes,
      source: "::code-review{invalid}",
      message: { id: "msg-1", threadId: "thread-1", turnId: "turn-1", projectId: "proj-1" },
      openWorkspaceFile: null,
    },
    {
      rpc: {
        localBranches: () => localBranches,
        localChanges: () => localChanges,
        branchReviewed: () => ({ paths }),
        status: () => ({ ok: true, login: "scott", accounts: ["scott"] }),
        pullRequest: () => pullRequest,
        changedFiles: () => ({
          ...localChanges,
          headRefOid: pullRequest.headRefOid,
          baseRefName: pullRequest.baseRefName,
        }),
        ...overrides,
      },
    },
  );
}

test("the branch card opens Changes and shares live review progress", async () => {
  const slot = await card({
    branch: localBranch.id,
    base: localBranch.base,
    head: localBranch.head,
  });
  await slot.findByText("0 of 1 file reviewed");
  expect(slot.getByText("scott/rate-limit")).toBeTruthy();
  expect(slot.getByText("src/limit.ts")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Review changes" }));
  expect(slot.navigateCalls).toEqual([
    {
      method: "toPluginPanel",
      path: "code-review",
      options: { subPath: `branch/${localBranch.id}/changes` },
    },
  ]);
  const { rpc } = await import("../src/app/rpc.ts");
  pluginQueryClient.setQueryData(rpc.branchReviewed.queryKey(branchReviewRange(localBranch)), {
    paths: ["src/limit.ts"],
  });
  await slot.findByText("Ready");
  expect(slot.getByRole("button", { name: "Open reviewed changes" })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("a failed branch-discovery refresh suppresses cached Ready and retries discovery", async () => {
  let failing = false;
  const slot = await card({ branch: localBranch.id }, ["src/limit.ts"], {
    localBranches: () => {
      if (failing) throw new Error("Machine disconnected");
      return localBranches;
    },
  });
  try {
    await slot.findByText("Ready");
    failing = true;
    await pluginQueryClient.invalidateQueries({ queryKey: rpc.localBranches.queryKey({}) });
    await slot.findByRole("alert");
    expect(slot.queryByText("Ready")).toBeNull();
    expect(slot.getByText("Progress unavailable")).toBeTruthy();
    failing = false;
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await slot.findByText("Ready");
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a newer realtime update supersedes a progress read already in flight", async () => {
  let reads = 0;
  let finishOld: ((value: { paths: string[] }) => void) | undefined;
  const old = new Promise<{ paths: string[] }>((resolve) => {
    finishOld = resolve;
  });
  const slot = await card({ branch: localBranch.id }, [], {
    branchReviewed: () => {
      reads++;
      return reads === 1 ? { paths: [] } : reads === 2 ? old : { paths: ["src/limit.ts"] };
    },
  });
  try {
    await slot.findByText("0 of 1 file reviewed");
    await slot.emitRealtime("branch-review", branchReviewRange(localBranch));
    await waitFor(() => expect(reads).toBe(2));
    await slot.emitRealtime("branch-review", branchReviewRange(localBranch));
    await slot.findByText("Ready");
    finishOld?.({ paths: [] });
    await waitFor(() => expect(slot.getByText("1 of 1 file reviewed")).toBeTruthy());
  } finally {
    finishOld?.({ paths: [] });
    slot.lifecycle.unmount();
  }
});

test("BB realtime reconnection refreshes local review marks", async () => {
  let paths: string[] = [];
  const slot = await card({ branch: localBranch.id }, [], { branchReviewed: () => ({ paths }) });
  try {
    await slot.findByText("0 of 1 file reviewed");
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    paths = ["src/limit.ts"];
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("Ready");
  } finally {
    slot.lifecycle.unmount();
  }
});

test("an open PR card polls GitHub and drops Ready when the PR changes", async () => {
  const timers = {
    setTimeout: (fn: () => void, delay: number) => setTimeout(fn, delay),
    clearTimeout: (id: ReturnType<typeof setTimeout> | undefined) => clearTimeout(id),
    setInterval: (fn: () => void, delay: number) => setInterval(fn, delay),
    clearInterval: (id: ReturnType<typeof setInterval> | undefined) => clearInterval(id),
  };
  timeoutManager.setTimeoutProvider({
    ...timers,
    setInterval: (fn, delay) => setInterval(fn, delay === 30_000 ? 20 : delay),
  });
  let moved = false;
  const slot = await card({ pr: "acme/api#42", account: "scott" }, [], {
    pullRequest: () => ({
      ...pullRequest,
      headRefOid: moved ? "d".repeat(40) : pullRequest.headRefOid,
    }),
    changedFiles: () => ({
      ...localChanges,
      headRefOid: moved ? "d".repeat(40) : pullRequest.headRefOid,
      baseRefName: pullRequest.baseRefName,
      files: localChanges.files.map((file) =>
        Object.assign({}, file, { viewed: moved ? "unviewed" : "viewed" }),
      ),
    }),
  });
  try {
    await slot.findByText("Ready");
    moved = true;
    await slot.findByText("0 of 1 file reviewed");
    expect(slot.queryByText("Ready")).toBeNull();
  } finally {
    slot.lifecycle.unmount();
    timeoutManager.setTimeoutProvider(timers);
  }
});

test("a moved branch explicitly offers its latest changes", async () => {
  const slot = await card({ branch: localBranch.id, head: "f".repeat(40) });
  await slot.findByText("New changes since this card was shared.");
  expect(slot.getByRole("button", { name: "Review latest changes" })).toBeTruthy();
  expect(slot.queryByText("Ready")).toBeNull();
  slot.lifecycle.unmount();
});

test("the PR card opens Changes as the specified account", async () => {
  const slot = await card({ pr: "acme/api#42", account: "scott" });
  await slot.findByText("Rate-limit the login endpoint");
  fireEvent.click(slot.getByRole("button", { name: "Review changes" }));
  expect(slot.navigateCalls).toEqual([
    {
      method: "toPluginPanel",
      path: "code-review",
      options: { subPath: "@scott/acme/api/pull/42/changes" },
    },
  ]);
  slot.lifecycle.unmount();
});

test("malformed directives stay literal and read nothing", async () => {
  const slot = await card({ branch: "../outside", pr: "javascript:alert(1)" });
  await waitFor(() => expect(slot.getByText("::code-review{invalid}")).toBeTruthy());
  expect(slot.rpcCalls).toEqual([]);
  slot.lifecycle.unmount();
});
