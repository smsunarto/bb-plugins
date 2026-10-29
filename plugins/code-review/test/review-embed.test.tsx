import "./dom.ts";
import { makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { beforeEach, expect, test } from "bun:test";
import { queryClient } from "../src/app/query.ts";
import { focusManager, onlineManager, timeoutManager } from "@tanstack/react-query";
import { branchReviewRange, sharedComparisonSubPath } from "../src/shared/schema.ts";
import { queryKey } from "../src/app/rpc.ts";
import { localBranch, localChanges, pullRequest } from "./app-fixtures.ts";

const { fireEvent, waitFor } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

beforeEach(() => queryClient.clear());

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
    await slot.findByText("Ready");
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
    expect(slot.getByText("Unavailable")).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
  }
});

async function card(
  attributes: Record<string, string>,
  paths: string[] = [],
  overrides: Record<string, (input: never) => unknown> = {},
  send: PluginBrowserBbSdk["threads"]["send"] = async () => ({ ok: true, delivery: "sent" }),
  messageId = "msg-1",
) {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = app.messageDirectives.find((each) => each.id === "code-review");
  if (!directive) throw new Error("No code-review directive");
  return renderSlot(
    directive,
    {
      attributes,
      source: "::code-review{invalid}",
      message: { id: messageId, threadId: "thread-1", turnId: "turn-1", projectId: "proj-1" },
      openWorkspaceFile: null,
    },
    {
      sdk: { threads: { send } },
      context: { threadId: "different-active-thread" },
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
  await slot.findByText("src/limit.ts");
  expect(slot.getByText("scott/rate-limit")).toBeTruthy();
  expect(slot.getByText("src/limit.ts")).toBeTruthy();
  expect(slot.queryByText("Needs review")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Review changes" }));
  expect(slot.navigateCalls).toEqual([
    {
      method: "toPluginPanel",
      path: "code-review",
      options: { subPath: `branch/${localBranch.id}/changes` },
    },
  ]);
  const { queryKey } = await import("../src/app/rpc.ts");
  queryClient.setQueryData(queryKey("branchReviewed", branchReviewRange(localBranch)), {
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
    await queryClient.invalidateQueries({
      queryKey: queryKey("localBranch", { id: localBranch.id }),
    });
    await slot.findByRole("alert");
    expect(slot.queryByText("Ready")).toBeNull();
    expect(slot.getByText("Unavailable")).toBeTruthy();
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
    await slot.findByText("src/limit.ts");
    await slot.emitRealtime("branch-review", branchReviewRange(localBranch));
    await waitFor(() => expect(reads).toBe(2));
    await slot.emitRealtime("branch-review", branchReviewRange(localBranch));
    await slot.findByText("Ready");
    finishOld?.({ paths: [] });
    await waitFor(() => expect(slot.getByText("Ready")).toBeTruthy());
  } finally {
    finishOld?.({ paths: [] });
    slot.lifecycle.unmount();
  }
});

test("BB realtime reconnection refreshes local review marks", async () => {
  let paths: string[] = [];
  const slot = await card({ branch: localBranch.id }, [], { branchReviewed: () => ({ paths }) });
  try {
    await slot.findByText("src/limit.ts");
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
    await waitFor(() => {
      expect(slot.queryByText("Ready")).toBeNull();
      expect(slot.queryByText("Unavailable")).toBeNull();
      expect(slot.queryByText("Loading")).toBeNull();
    });
  } finally {
    slot.lifecycle.unmount();
    timeoutManager.setTimeoutProvider(timers);
  }
});

test("a moved branch shows its current changes without a special update state", async () => {
  const slot = await card({ branch: localBranch.id, head: "f".repeat(40) });
  await slot.findByText("src/limit.ts");
  expect(slot.queryByText("New changes since this card was shared.")).toBeNull();
  expect(slot.getByRole("button", { name: "Review changes" })).toBeTruthy();
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
    await slot.findByText("src/limit.ts");
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
    await slot.findByText("src/limit.ts");
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    moved = true;
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() =>
      expect(
        slot.rpcCalls.some(
          (call) =>
            call.method === "localChanges" &&
            (call.input as { head: string }).head === "d".repeat(40),
        ),
      ).toBe(true),
    );
    await slot.findByText(/→ ddddddd$/);
    expect(slot.queryByText("New changes since this card was shared.")).toBeNull();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("Review changes opens the card's revision even with an older inbox cached", async () => {
  const head = "d".repeat(40);
  const latest = { ...localBranch, head };
  queryClient.setQueryData(queryKey("localBranches", {}), {
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
    await slot.findByText(localBranch.branch);
    fireEvent.click(await slot.findByRole("button", { name: "Review changes" }));
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
    expect(slot.getByText("Unavailable")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Open Review" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(reads).toBe(2));
  } finally {
    slot.lifecycle.unmount();
    timeoutManager.setTimeoutProvider(timers);
  }
});

test("a fresh cached original cannot report Ready when branch discovery and checkout reads fail", async () => {
  const { hostId, path, base, head } = localBranch;
  queryClient.setQueryData(queryKey("localChanges", { hostId, path, base, head }), localChanges);
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
    await slot.findByText("src/limit.ts");
    recovered = true;
    fireEvent.click(slot.getByRole("button", { name: "Check latest branch" }));
    await slot.findByText(localBranch.branch);
    await slot.findByText("src/limit.ts");
    expect(slot.queryByText("New changes since this card was shared.")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Review changes" }));
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
    await slot.findByText("src/limit.ts");
  } finally {
    slot.lifecycle.unmount();
  }
});

const shipTargets: Record<string, string>[] = [{ branch: localBranch.id }, { pr: "owner/repo#7" }];
for (const attributes of shipTargets) {
  test(`Ship it sends to the card's thread for ${"branch" in attributes ? "branches" : "PRs"}`, async () => {
    const messages: unknown[] = [];
    let finish: (() => void) | undefined;
    const slot = await card(attributes, [], {}, async (message) => {
      messages.push(message);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { ok: true, delivery: "sent" };
    });
    try {
      fireEvent.click(await slot.findByRole("button", { name: "Ship it" }));
      await waitFor(() =>
        expect(messages).toEqual([
          {
            threadId: "thread-1",
            mode: "queue-if-active",
            input: [{ type: "text", text: "ship it", mentions: [] }],
          },
        ]),
      );
      const pending = await slot.findByRole("button", { name: "Sending…" });
      expect(pending.hasAttribute("disabled")).toBe(true);
      fireEvent.click(pending);
      expect(messages).toHaveLength(1);
      finish?.();
      expect((await slot.findByRole("button", { name: "Sent" })).hasAttribute("disabled")).toBe(
        true,
      );
    } finally {
      finish?.();
      slot.lifecycle.unmount();
    }
  });
}

test("Ship it shows a send failure and allows retry", async () => {
  let attempts = 0;
  const slot = await card({ branch: localBranch.id }, [], {}, async () => {
    if (++attempts === 1) throw new Error("Connection lost");
    return { ok: true, delivery: "sent" };
  });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Ship it" }));
    await slot.findByText("Could not send: Connection lost");
    fireEvent.click(slot.getByRole("button", { name: "Ship it" }));
    await slot.findByRole("button", { name: "Sent" });
    expect(attempts).toBe(2);
    expect(slot.queryByText("Could not send: Connection lost")).toBeNull();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("Ship it reports queued delivery on a busy thread", async () => {
  const slot = await card({ branch: localBranch.id }, [], {}, async () => ({
    ok: true,
    delivery: "queued",
    queuedMessage: makeQueueEntry({ threadId: "thread-1" }),
  }));
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Ship it" }));
    expect((await slot.findByRole("button", { name: "Queued" })).hasAttribute("disabled")).toBe(
      true,
    );
  } finally {
    slot.lifecycle.unmount();
  }
});

test("Ship it keeps sending state when branch discovery replaces the loading card", async () => {
  let discover: ((value: typeof localBranch) => void) | undefined;
  let deliver: (() => void) | undefined;
  let sends = 0;
  const slot = await card(
    { branch: localBranch.id },
    [],
    {
      localBranch: () =>
        new Promise<typeof localBranch>((resolve) => {
          discover = resolve;
        }),
    },
    async () => {
      sends++;
      await new Promise<void>((resolve) => {
        deliver = resolve;
      });
      return { ok: true, delivery: "sent" };
    },
  );
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Ship it" }));
    await slot.findByRole("button", { name: "Sending…" });
    discover?.(localBranch);
    await slot.findByText(localBranch.branch);
    expect(slot.getByRole("button", { name: "Sending…" }).hasAttribute("disabled")).toBe(true);
    deliver?.();
    await slot.findByRole("button", { name: "Sent" });
    expect(sends).toBe(1);
  } finally {
    deliver?.();
    slot.lifecycle.unmount();
  }
});

test("branch discovery keeps the card, action DOM, and keyboard focus", async () => {
  let discover: ((value: typeof localBranch) => void) | undefined;
  const slot = await card({ branch: localBranch.id }, [], {
    localBranch: () =>
      new Promise<typeof localBranch>((resolve) => {
        discover = resolve;
      }),
  });
  try {
    const section = slot.getByRole("region", { name: "Changes for review" });
    const action = slot.getByRole("button", { name: "Review changes" });
    action.focus();
    discover?.(localBranch);
    await slot.findByText("src/limit.ts");
    expect(slot.getByRole("region", { name: "Changes for review" })).toBe(section);
    expect(slot.getByRole("button", { name: "Review changes" })).toBe(action);
    expect(document.activeElement).toBe(action);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("retrying an original comparison preserves the card and Ship it DOM", async () => {
  let recovered = false;
  const slot = await card(
    { branch: localBranch.id, base: localBranch.base, head: localBranch.head },
    [],
    {
      localBranch: () => {
        if (!recovered) throw new Error("Offline");
        return localBranch;
      },
      sharedComparison: () => ({
        ...branchReviewRange(localBranch),
        hostId: localBranch.hostId,
        path: localBranch.path,
      }),
    },
  );
  try {
    await slot.findByText("src/limit.ts");
    const section = slot.getByRole("region", { name: "Changes for review" });
    const ship = slot.getByRole("button", { name: "Ship it" });
    recovered = true;
    fireEvent.click(slot.getByRole("button", { name: "Check latest branch" }));
    await slot.findByText(localBranch.branch);
    expect(slot.getByRole("region", { name: "Changes for review" })).toBe(section);
    expect(slot.getByRole("button", { name: "Ship it" })).toBe(ship);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("PR account discovery preserves the card and action DOM", async () => {
  let authenticate: ((value: unknown) => void) | undefined;
  const slot = await card({ pr: "acme/api#42" }, [], {
    status: () =>
      new Promise((resolve) => {
        authenticate = resolve;
      }),
  });
  try {
    const section = slot.getByRole("region", { name: "Changes for review" });
    const action = slot.getByRole("button", { name: "Review changes" });
    authenticate?.({ ok: true, login: "scott", accounts: ["scott"] });
    await slot.findByText(pullRequest.title);
    expect(slot.getByRole("region", { name: "Changes for review" })).toBe(section);
    expect(slot.getByRole("button", { name: "Review changes" })).toBe(action);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a remounted card retains pending and queued delivery without sending twice", async () => {
  let deliver: (() => void) | undefined;
  let sends = 0;
  const send: PluginBrowserBbSdk["threads"]["send"] = async () => {
    sends++;
    await new Promise<void>((resolve) => {
      deliver = resolve;
    });
    return {
      ok: true,
      delivery: "queued",
      queuedMessage: makeQueueEntry({ threadId: "thread-1" }),
    };
  };
  let slot = await card({ branch: localBranch.id }, [], {}, send);
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Ship it" }));
    await slot.findByRole("button", { name: "Sending…" });
    slot.lifecycle.unmount();
    slot = await card({ branch: localBranch.id }, [], {}, send);
    const pending = await slot.findByRole("button", { name: "Sending…" });
    expect(pending.hasAttribute("disabled")).toBe(true);
    fireEvent.click(pending);
    deliver?.();
    await slot.findByRole("button", { name: "Queued" });
    slot.lifecycle.unmount();
    slot = await card({ branch: localBranch.id }, [], {}, send);
    expect((await slot.findByRole("button", { name: "Queued" })).hasAttribute("disabled")).toBe(
      true,
    );
    expect(sends).toBe(1);
    slot.lifecycle.unmount();
    slot = await card({ branch: localBranch.id }, [], {}, send, "another-message");
    expect((await slot.findByRole("button", { name: "Ship it" })).hasAttribute("disabled")).toBe(
      false,
    );
  } finally {
    deliver?.();
    slot.lifecycle.unmount();
  }
});

test("entrances do not replay on data updates or remounts, and reduced motion stays still", async () => {
  const animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  const mediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
  const animated: HTMLElement[] = [];
  let reduce = false;
  let cancellations = 0;
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: function (this: HTMLElement) {
      animated.push(this);
      return {
        cancel() {
          cancellations++;
        },
      };
    },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: reduce }),
  });
  let discover: ((value: typeof localBranch) => void) | undefined;
  let slot = await card(
    { branch: localBranch.id },
    [],
    {
      localBranch: () =>
        new Promise<typeof localBranch>((resolve) => {
          discover = resolve;
        }),
    },
    undefined,
    "motion-card",
  );
  try {
    expect(animated).toHaveLength(1);
    discover?.(localBranch);
    await slot.findByText("src/limit.ts");
    expect(animated).toHaveLength(1);
    slot.lifecycle.unmount();
    slot = await card({ branch: localBranch.id }, [], {}, undefined, "motion-card");
    await slot.findByText("src/limit.ts");
    expect(animated).toHaveLength(1);
    fireEvent.click(slot.getByRole("button", { name: "Ship it" })); // detail=0: keyboard/programmatic
    await slot.findByRole("button", { name: "Sent" });
    expect(animated).toHaveLength(1);
    slot.lifecycle.unmount();
    reduce = true;
    slot = await card({ branch: localBranch.id }, [], {}, undefined, "reduced-card");
    fireEvent.click(await slot.findByRole("button", { name: "Ship it" }), { detail: 1 });
    await slot.findByRole("button", { name: "Sent" });
    expect(animated).toHaveLength(1);
    slot.lifecycle.unmount();
    reduce = false;
    slot = await card({ branch: localBranch.id }, [], {}, undefined, "pointer-feedback-card");
    const beforeSend = animated.length;
    fireEvent.click(await slot.findByRole("button", { name: "Ship it" }), { detail: 1 });
    await slot.findByRole("button", { name: "Sent" });
    await waitFor(() => expect(animated.length).toBeGreaterThan(beforeSend));
    expect(animated.at(-1)?.tagName).toBe("SPAN");
    slot.lifecycle.unmount();
    expect(cancellations).toBe(animated.length);
  } finally {
    slot.lifecycle.unmount();
    if (animateDescriptor)
      Object.defineProperty(HTMLElement.prototype, "animate", animateDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "animate");
    if (mediaDescriptor) Object.defineProperty(window, "matchMedia", mediaDescriptor);
    else Reflect.deleteProperty(window, "matchMedia");
  }
});

test("a verified fallback stays Ready through warm focus and a background file refresh", async () => {
  let reads = 0;
  let finish: ((value: typeof localChanges) => void) | undefined;
  const slot = await card(
    { branch: localBranch.id, base: localBranch.base, head: localBranch.head },
    ["src/limit.ts"],
    {
      localBranch: () => {
        throw new Error("No branch");
      },
      sharedComparison: () => ({
        ...branchReviewRange(localBranch),
        hostId: localBranch.hostId,
        path: localBranch.path,
      }),
      localChanges: () => {
        if (++reads === 1) return localChanges;
        return new Promise<typeof localChanges>((resolve) => {
          finish = resolve;
        });
      },
    },
  );
  try {
    await slot.findByText("Ready");
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reads).toBe(1);
    void queryClient.invalidateQueries({
      queryKey: queryKey("localChanges", {
        hostId: localBranch.hostId,
        path: localBranch.path,
        base: localBranch.base,
        head: localBranch.head,
      }),
    });
    await waitFor(() => expect(reads).toBe(2));
    expect(slot.getByText("Ready")).toBeTruthy();
    expect(slot.queryByText("Loading")).toBeNull();
    finish?.(localChanges);
  } finally {
    finish?.(localChanges);
    slot.lifecycle.unmount();
    focusManager.setFocused(undefined);
  }
});

test("paused discovery keeps the checking footer instead of reporting an unavailable branch", async () => {
  onlineManager.setOnline(false);
  const slot = await card({
    branch: localBranch.id,
    base: localBranch.base,
    head: localBranch.head,
  });
  try {
    expect(
      slot.getByText("Checking latest branch… Original comparison available below."),
    ).toBeTruthy();
    expect(slot.queryByText(/Latest branch unavailable/)).toBeNull();
    expect(slot.rpcCalls.some((call) => call.method === "localChanges")).toBe(false);
  } finally {
    slot.lifecycle.unmount();
    onlineManager.setOnline(true);
  }
});
