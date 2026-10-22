import "./dom.ts";
import { beforeEach, expect, test } from "bun:test";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { timeoutManager } from "@tanstack/react-query";
import { branchReviewRange, sharedComparisonSubPath } from "../src/shared/schema.ts";
import { rpc } from "../src/app/rpc.ts";
import { localBranch, localChanges, pullRequest } from "./app-fixtures.ts";

const { fireEvent, waitFor } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

beforeEach(() => pluginQueryClient.clear());

test("a pinned card stays usable while legacy branch discovery is still pending", async () => {
  const slot = await card(
    { branch: localBranch.id, base: localBranch.base, head: localBranch.head },
    [],
    {
      localBranch: () => new Promise(() => {}),
      sharedComparison: () => ({
        ...branchReviewRange(localBranch),
        hostId: localBranch.hostId,
        path: localBranch.path,
      }),
    },
  );
  try {
    await slot.findByText("Branch changes");
    expect(slot.queryByText("Ready")).toBeNull();
    expect(slot.queryByText("Shared changes")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Review original comparison" }));
    expect(slot.navigateCalls.at(-1)).toEqual({
      method: "toPluginPanel",
      path: "code-review",
      options: {
        subPath: sharedComparisonSubPath({
          ...branchReviewRange(localBranch),
          threadId: "thread-1",
        }),
      },
    });
    expect(
      slot.rpcCalls.some((call) =>
        ["sharedComparison", "localChanges", "branchReviewed"].includes(call.method),
      ),
    ).toBe(false);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a shipped branch card opens its original comparison and preserves its review marks", async () => {
  const range = { ...branchReviewRange(localBranch), threadId: "thread-1" };
  const slot = await card(
    { branch: range.id, base: range.base, head: range.head },
    ["src/limit.ts"],
    {
      localBranch: () => {
        throw new Error("This branch is no longer unpublished, or its machine is offline.");
      },
      sharedComparison: () => ({
        ...branchReviewRange(localBranch),
        hostId: localBranch.hostId,
        path: localBranch.path,
      }),
    },
  );
  try {
    await slot.findByText("1 of 1 file reviewed");
    expect(slot.getByText("Shared changes")).toBeTruthy();
    expect(slot.getByText("src/limit.ts")).toBeTruthy();
    expect(slot.queryByRole("alert")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Review original comparison" }));
    expect(slot.navigateCalls.at(-1)).toEqual({
      method: "toPluginPanel",
      path: "code-review",
      options: { subPath: sharedComparisonSubPath(range) },
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a shipped card with an offline checkout never reports cached review marks as Ready", async () => {
  const slot = await card(
    { branch: localBranch.id, base: localBranch.base, head: localBranch.head },
    ["src/limit.ts"],
    {
      localBranch: () => {
        throw new Error("No unpublished branches");
      },
      sharedComparison: () => ({
        ...branchReviewRange(localBranch),
        hostId: localBranch.hostId,
        path: localBranch.path,
      }),
      localChanges: () => {
        throw new Error("Checkout host is offline");
      },
    },
  );
  try {
    await slot.findByText("Checkout host is offline");
    expect(slot.queryByText("Ready")).toBeNull();
    expect(slot.getByText("Progress unavailable")).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
  }
});

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
        localBranch: () => localBranch,
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
  const slot = await card(
    { branch: localBranch.id, base: localBranch.base, head: localBranch.head },
    ["src/limit.ts"],
    {
      localBranch: () => {
        if (failing) throw new Error("Machine disconnected");
        return localBranch;
      },
    },
  );
  try {
    await slot.findByText("Ready");
    failing = true;
    await pluginQueryClient.invalidateQueries({
      queryKey: rpc.localBranch.queryKey({ id: localBranch.id }),
    });
    await slot.findByRole("alert");
    expect(slot.queryByText("Ready")).toBeNull();
    expect(slot.getByText("Progress unavailable")).toBeTruthy();
    expect(slot.getByText(localBranch.branch)).toBeTruthy();
    expect(slot.queryByText("Shared changes")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Review original comparison" }));
    expect(slot.navigateCalls.at(-1)).toEqual({
      method: "toPluginPanel",
      path: "code-review",
      options: {
        subPath: sharedComparisonSubPath({
          ...branchReviewRange(localBranch),
          threadId: "thread-1",
        }),
      },
    });
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

test("a branch card renders even while fleet discovery never answers", async () => {
  let fleetReads = 0;
  const slot = await card({ branch: localBranch.id }, [], {
    localBranches: () => {
      fleetReads++;
      return new Promise(() => {});
    },
  });
  try {
    await slot.findByText("0 of 1 file reviewed");
    expect(slot.getByText("src/limit.ts")).toBeTruthy();
    expect(fleetReads).toBe(0);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("BB reconnect refreshes the card's own branch revision", async () => {
  let moved = false;
  const slot = await card({ branch: localBranch.id, head: localBranch.head }, [], {
    localBranch: () => ({ ...localBranch, head: moved ? "d".repeat(40) : localBranch.head }),
  });
  try {
    await slot.findByText("0 of 1 file reviewed");
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    moved = true;
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("New changes since this card was shared.");
  } finally {
    slot.lifecycle.unmount();
  }
});

test("Review latest changes opens the card's revision even with an older inbox cached", async () => {
  const head = "d".repeat(40);
  const latest = { ...localBranch, head };
  pluginQueryClient.setQueryData(rpc.localBranches.queryKey({}), {
    available: true,
    branches: [localBranch],
  });
  const slot = await card({ branch: localBranch.id, head: localBranch.head }, ["src/limit.ts"], {
    localBranch: () => latest,
    localChanges: (input: unknown) => ({
      ...localChanges,
      headRefOid: (input as { head: string }).head,
    }),
  });
  let page: Awaited<ReturnType<typeof renderSlot>> | undefined;
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Review latest changes" }));
    const navigation = slot.navigateCalls.at(-1)!;
    if (navigation.method !== "toPluginPanel") throw new Error("Expected review panel navigation");
    const app = await loadPluginApp(() => import("../src/app/app.tsx"));
    page = await renderSlot(
      app.navPanels[0]!,
      { subPath: navigation.options?.subPath ?? "" },
      {
        rpc: {
          localBranch: () => latest,
          localChanges: (input: unknown) => ({
            ...localChanges,
            headRefOid: (input as { head: string }).head,
          }),
          branchReviewed: () => ({ paths: ["src/limit.ts"] }),
          branchActivity: () => ({ threads: [], latestReview: null }),
          reviewInstructions: () => ({ instructions: "" }),
        },
      },
    );
    await page.findByRole("article", { name: "src/limit.ts" });
    const reads = [...slot.rpcCalls, ...page.rpcCalls];
    expect([
      ...new Set(
        reads
          .filter((call) => call.method === "localChanges")
          .map((call) => (call.input as { head: string }).head),
      ),
    ]).toEqual([head]);
    expect([
      ...new Set(
        reads
          .filter((call) => call.method === "branchReviewed")
          .map((call) => (call.input as { head: string }).head),
      ),
    ]).toEqual([head]);
    expect(
      (page.getByRole("checkbox", { name: "Reviewed src/limit.ts" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(page.rpcCalls.some((call) => call.method === "localBranches")).toBe(false);
  } finally {
    page?.lifecycle.unmount();
    slot.lifecycle.unmount();
  }
});

test("a missing card does not retry or poll fleet discovery", async () => {
  const timers = {
    setTimeout: (fn: () => void, delay: number) => setTimeout(fn, delay),
    clearTimeout: (id: ReturnType<typeof setTimeout> | undefined) => clearTimeout(id),
    setInterval: (fn: () => void, delay: number) => setInterval(fn, delay),
    clearInterval: (id: ReturnType<typeof setInterval> | undefined) => clearInterval(id),
  };
  timeoutManager.setTimeoutProvider({
    ...timers,
    setInterval: (fn, delay) => setInterval(fn, delay === 30_000 ? 10 : delay),
  });
  let reads = 0;
  const slot = await card({ branch: localBranch.id }, [], {
    localBranch: () => {
      reads++;
      throw new Error("This branch is no longer unpublished, or its machine is offline.");
    },
  });
  try {
    await slot.findByRole("alert");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(reads).toBe(1);
    expect(slot.getByText("Progress unavailable")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(reads).toBe(2));
  } finally {
    slot.lifecycle.unmount();
    timeoutManager.setTimeoutProvider(timers);
  }
});

test("a fresh cached original cannot report Ready when branch discovery and checkout reads fail", async () => {
  const { hostId, path, base, head } = localBranch;
  pluginQueryClient.setQueryData(
    rpc.localChanges.queryKey({ hostId, path, base, head }),
    localChanges,
  );
  let reads = 0;
  const slot = await card({ branch: localBranch.id, base, head }, ["src/limit.ts"], {
    localBranch: () => {
      throw new Error("Machine disconnected");
    },
    sharedComparison: () => ({ ...branchReviewRange(localBranch), hostId, path }),
    localChanges: () => {
      reads++;
      throw new Error("Checkout host is offline");
    },
  });
  try {
    await slot.findByText("Checkout host is offline");
    expect(reads).toBeGreaterThan(0);
    expect(slot.queryByText("Ready")).toBeNull();
    expect(slot.getByText("src/limit.ts")).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a pending original defers file reads and checks the checkout after discovery fails", async () => {
  let failDiscovery: ((reason: Error) => void) | undefined;
  const discovery = new Promise((_, reject) => {
    failDiscovery = reject;
  });
  let offline = false;
  const slot = await card(
    { branch: localBranch.id, base: localBranch.base, head: localBranch.head },
    ["src/limit.ts"],
    {
      localBranch: () => discovery,
      sharedComparison: () => ({
        ...branchReviewRange(localBranch),
        hostId: localBranch.hostId,
        path: localBranch.path,
      }),
      localChanges: () => {
        if (offline) throw new Error("Checkout host is offline");
        return localChanges;
      },
    },
  );
  try {
    await slot.findByText("Branch changes");
    expect(slot.queryByText("Ready")).toBeNull();
    expect(slot.rpcCalls.some((call) => call.method === "localChanges")).toBe(false);
    offline = true;
    failDiscovery?.(new Error("Machine disconnected"));
    await slot.findByText("Checkout host is offline");
    expect(slot.queryByText("Ready")).toBeNull();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a successful original comparison can retry discovery and restore a moved branch", async () => {
  let recovered = false;
  const slot = await card(
    { branch: localBranch.id, base: localBranch.base, head: localBranch.head },
    [],
    {
      localBranch: () => {
        if (!recovered) throw new Error("Temporary branch lookup failure");
        return { ...localBranch, head: "f".repeat(40) };
      },
      sharedComparison: () => ({
        ...branchReviewRange(localBranch),
        hostId: localBranch.hostId,
        path: localBranch.path,
      }),
    },
  );
  try {
    await slot.findByText("0 of 1 file reviewed");
    recovered = true;
    fireEvent.click(slot.getByRole("button", { name: "Check latest branch" }));
    await slot.findByText(localBranch.branch);
    await slot.findByText("New changes since this card was shared.");
    fireEvent.click(slot.getByRole("button", { name: "Review latest changes" }));
    expect(slot.navigateCalls.at(-1)).toEqual({
      method: "toPluginPanel",
      path: "code-review",
      options: { subPath: `branch/${localBranch.id}/changes` },
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("reconnection retries a failed shared checkout lookup on a card", async () => {
  let recovered = false;
  const slot = await card(
    { branch: localBranch.id, base: localBranch.base, head: localBranch.head },
    [],
    {
      localBranch: () => {
        throw new Error("No unpublished branch");
      },
      sharedComparison: () => {
        if (!recovered) throw new Error("Checkout not ready");
        return {
          ...branchReviewRange(localBranch),
          hostId: localBranch.hostId,
          path: localBranch.path,
        };
      },
    },
  );
  try {
    await slot.findByText("Checkout not ready");
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    recovered = true;
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("0 of 1 file reviewed");
  } finally {
    slot.lifecycle.unmount();
  }
});
