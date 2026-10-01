import { expect, setSystemTime, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type {
  PluginBrowserBbSdk,
  PluginProvidersState,
  PluginRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";

installDom();
const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

type Children = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["list"]>>;
type Change =
  | "thread-created"
  | "status-changed"
  | "thread-deleted"
  | "parent-changed"
  | "archived-changed";

async function renderHeader(
  threads: ReturnType<typeof makeThreadResponse>[],
  isCompactViewport = false,
  get?: PluginBrowserBbSdk["threads"]["get"],
  realtimeConnectionState: PluginRealtimeConnectionState = "connected",
  subscribe: PluginBrowserBbSdk["subscribe"] = () => () => {},
) {
  const app = await loadPluginApp(() => import("./app.tsx"));
  let slot!: ReturnType<typeof renderSlot>;
  await act(async () => {
    slot = renderSlot(
      app.threadHeaderActions[0]!,
      { threadId: "thr_review", projectId: "proj_1", isCompactViewport },
      {
        pluginId: "review",
        realtimeConnectionState,
        // Another focused pane must not decide this header's return target.
        context: { threadId: "thr_other_pane" },
        // The real sidebar roster excludes hidden threads. Leave it empty.
        sdk: {
          subscribe,
          threads: {
            get:
              get ??
              (async ({ threadId }) => {
                const thread = threads.find((thread) => thread.id === threadId);
                if (!thread) throw new Error("Unexpected thread lookup");
                return thread;
              }),
          },
        },
      },
    );
  });
  return slot;
}

for (const status of ["active", "idle", "error"] as const) {
  test(`an ${status} review has a header button that returns to its main thread`, async () => {
    const slot = await renderHeader([
      makeThreadResponse({
        id: "thr_review",
        parentThreadId: "thr_author",
        originPluginId: "review",
        visibility: "hidden",
        status,
      }),
      makeThreadResponse({ id: "thr_other_pane", parentThreadId: "thr_other_parent" }),
    ]);
    try {
      const button = slot.getByRole("button", { name: "Back to main thread" });
      expect(button.textContent).toBe("Back to main thread");
      fireEvent.click(button);
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "thr_author" },
      ]);
    } finally {
      slot.unmount();
    }
  });
}

test("compact review headers keep an accessible return button and unrelated threads do not", async () => {
  const review = makeThreadResponse({
    id: "thr_review",
    parentThreadId: "thr_author",
    originPluginId: "review",
  });
  const compact = await renderHeader([review], true);
  try {
    const button = compact.getByRole("button", { name: "Back to main thread" });
    expect(button.textContent).toBe("");
    fireEvent.click(button);
    expect(compact.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_author" },
    ]);
  } finally {
    compact.unmount();
  }
  for (const other of [
    { ...review, originPluginId: "other-plugin" },
    { ...review, parentThreadId: null },
  ]) {
    const slot = await renderHeader([other]);
    try {
      expect(slot.queryByRole("button", { name: "Back to main thread" })).toBeNull();
    } finally {
      slot.unmount();
    }
  }
});

for (const connection of ["connecting", "reconnecting"] as const) {
  test(`return navigation works while realtime is ${connection}`, async () => {
    const slot = await renderHeader(
      [
        makeThreadResponse({
          id: "thr_review",
          originPluginId: "review",
          parentThreadId: "thr_author",
        }),
      ],
      false,
      undefined,
      connection,
    );
    try {
      fireEvent.click(slot.getByRole("button", { name: "Back to main thread" }));
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "thr_author" },
      ]);
    } finally {
      slot.unmount();
    }
  });
}

test("an archived hidden review still returns to its main thread", async () => {
  const slot = await renderHeader([
    makeThreadResponse({
      id: "thr_review",
      parentThreadId: "thr_author",
      originPluginId: "review",
      visibility: "hidden",
      archivedAt: 123,
      status: "idle",
    }),
  ]);
  try {
    fireEvent.click(slot.getByRole("button", { name: "Back to main thread" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_author" }]);
  } finally {
    slot.unmount();
  }
});

test("a failed header lookup retries and restores return navigation", async () => {
  let calls = 0;
  const slot = await renderHeader([], false, async () => {
    calls += 1;
    if (calls === 1) throw new Error("Transient connection failure");
    return makeThreadResponse({
      id: "thr_review",
      parentThreadId: "thr_author",
      originPluginId: "review",
    });
  });
  try {
    const button = await slot.findByRole(
      "button",
      { name: "Back to main thread" },
      { timeout: 2000 },
    );
    fireEvent.click(button);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_author" }]);
    expect(calls).toBe(2);
  } finally {
    slot.unmount();
  }
});

test("parent changes replace the return target, ignore old responses, and hide it when detached", async () => {
  let notify = (_id: string) => {};
  let resolveOld!: (thread: ReturnType<typeof makeThreadResponse>) => void;
  const old = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => {
    resolveOld = resolve;
  });
  let parentThreadId: string | null = "thr_author";
  let calls = 0;
  const slot = await renderHeader(
    [],
    false,
    async () => {
      calls += 1;
      if (calls === 2) return old;
      return makeThreadResponse({ id: "thr_review", originPluginId: "review", parentThreadId });
    },
    "connected",
    (args) => {
      if (args.event !== "thread:changed") throw new Error("Unexpected subscription");
      const callback = args.callback as (event: {
        type: "changed";
        entity: "thread";
        id: string;
        changes: Change[];
      }) => void;
      notify = (id) =>
        callback({ type: "changed", entity: "thread", id, changes: ["parent-changed"] });
      return () => {};
    },
  );
  try {
    fireEvent.click(slot.getByRole("button", { name: "Back to main thread" }));
    await act(async () => notify("thr_review"));
    expect(slot.queryByRole("button", { name: "Back to main thread" })).toBeNull();
    parentThreadId = "thr_new_parent";
    await act(async () => notify("thr_review"));
    await act(async () =>
      resolveOld(
        makeThreadResponse({
          id: "thr_review",
          originPluginId: "review",
          parentThreadId: "thr_author",
        }),
      ),
    );
    fireEvent.click(slot.getByRole("button", { name: "Back to main thread" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_author" },
      { method: "toThread", threadId: "thr_new_parent" },
    ]);
    parentThreadId = null;
    await act(async () => notify("thr_review"));
    expect(slot.queryByRole("button", { name: "Back to main thread" })).toBeNull();
    await act(async () => notify("thr_unrelated"));
    expect(calls).toBe(4);
  } finally {
    slot.unmount();
  }
});

test("reconnecting refreshes a parent change missed while offline", async () => {
  let parentThreadId = "thr_author";
  const slot = await renderHeader([], false, async () =>
    makeThreadResponse({ id: "thr_review", originPluginId: "review", parentThreadId }),
  );
  try {
    fireEvent.click(slot.getByRole("button", { name: "Back to main thread" }));
    parentThreadId = "thr_new_parent";
    await act(async () => slot.behavior.setRealtimeConnectionState("reconnecting"));
    fireEvent.click(slot.getByRole("button", { name: "Back to main thread" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_author" },
      { method: "toThread", threadId: "thr_new_parent" },
    ]);
  } finally {
    slot.unmount();
  }
});

test("header lookup cleanup cancels a scheduled retry", async () => {
  let calls = 0;
  const slot = await renderHeader([], false, async () => {
    calls += 1;
    throw new Error("Transient connection failure");
  });
  slot.unmount();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(calls).toBe(1);
});

test("switching header threads never exposes a stale return target", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const Header = app.threadHeaderActions[0]!.component;
  let resolveSlow!: (thread: ReturnType<typeof makeThreadResponse>) => void;
  const slow = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => {
    resolveSlow = resolve;
  });
  const slot = await renderHeader([], false, async ({ threadId }) => {
    if (threadId === "thr_slow") return slow;
    return makeThreadResponse({
      id: threadId,
      parentThreadId: `${threadId}_parent`,
      originPluginId: "review",
    });
  });
  try {
    expect(slot.getByRole("button", { name: "Back to main thread" }).textContent).toBe(
      "Back to main thread",
    );
    await act(async () =>
      slot.rerender(<Header threadId="thr_slow" projectId="proj_1" isCompactViewport={false} />),
    );
    expect(slot.queryByRole("button", { name: "Back to main thread" })).toBeNull();
    await act(async () =>
      slot.rerender(<Header threadId="thr_new" projectId="proj_1" isCompactViewport={false} />),
    );
    await act(async () =>
      resolveSlow(
        makeThreadResponse({
          id: "thr_slow",
          parentThreadId: "thr_wrong_parent",
          originPluginId: "review",
        }),
      ),
    );
    fireEvent.click(slot.getByRole("button", { name: "Back to main thread" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_new_parent" },
    ]);
  } finally {
    slot.unmount();
  }
});

function child(overrides: Parameters<typeof makeThreadResponse>[0]): Children[number] {
  return {
    ...makeThreadResponse(overrides),
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    environmentBranchName: null,
    environmentHostId: null,
    environmentIsWorktree: null,
    environmentName: null,
    environmentPath: null,
    environmentProviderId: null,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
    pinSortKey: null,
    queuedWork: "none",
  };
}

async function renderBanner(
  list: PluginBrowserBbSdk["threads"]["list"],
  get: PluginBrowserBbSdk["threads"]["get"] = async ({ threadId }) =>
    makeThreadResponse({ id: threadId }),
  threadId = "thr_author",
  realtimeConnectionState: PluginRealtimeConnectionState = "connected",
  providers?: Partial<PluginProvidersState>,
) {
  const app = await loadPluginApp(() => import("./app.tsx"));
  type Event = { type: "changed"; entity: "thread"; id: string; changes: Change[] };
  const listeners = new Set<(event: Event) => void>();
  let slot!: ReturnType<typeof renderSlot>;
  await act(async () => {
    slot = renderSlot(
      app.composerCustomizations[0]!.banners![0]!,
      {},
      {
        pluginId: "review",
        realtimeConnectionState,
        providers,
        context: { threadId: "thr_other_pane" },
        composer: { scope: { kind: "thread", threadId } },
        sdk: {
          threads: { list, get },
          subscribe: (args) => {
            if (args.event !== "thread:changed") throw new Error("Unexpected subscription");
            const callback = args.callback as (event: Event) => void;
            listeners.add(callback);
            return () => {
              listeners.delete(callback);
            };
          },
        },
      },
    );
  });
  return {
    slot,
    change: (id: string, changes: Change[]) =>
      act(async () => {
        for (const listener of listeners)
          listener({ type: "changed", entity: "thread", id, changes });
      }),
  };
}

test("ordinary threads reserve no empty banner while discovering whether reviews exist", async () => {
  let resolveDiscovery!: (children: Children) => void;
  let result = new Promise<Children>((resolve) => {
    resolveDiscovery = resolve;
  });
  const { slot, change } = await renderBanner(async () => result);
  try {
    expect(slot.container.querySelector("[data-review-navigation]")).toBeNull();
    await act(async () => resolveDiscovery([]));
    expect(slot.container.querySelector("[data-review-navigation]")).toBeNull();
    result = Promise.resolve([child({ id: "thr_review", status: "active" })]);
    await change("thr_review", ["thread-created"]);
    fireEvent.click(
      slot.getByRole("button", { name: "Adversarial review running. Open the review thread." }),
    );
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_review" }]);
  } finally {
    slot.unmount();
  }
});

test("known review pairs retain the banner space through fresh lookups without exposing old targets", async () => {
  let resolveParent!: (thread: ReturnType<typeof makeThreadResponse>) => void;
  const parentLookup = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => {
    resolveParent = resolve;
  });
  let resolveChildren!: (children: Children) => void;
  const childrenLookup = new Promise<Children>((resolve) => {
    resolveChildren = resolve;
  });
  let revisiting = false;
  const { slot } = await renderBanner(
    async (args) =>
      args?.parentThreadId === "thr_review"
        ? []
        : revisiting
          ? childrenLookup
          : [child({ id: "thr_review", status: "idle" })],
    async ({ threadId }) =>
      threadId === "thr_review" ? parentLookup : makeThreadResponse({ id: threadId }),
  );
  try {
    fireEvent.click(
      slot.getByRole("button", { name: "Adversarial review complete. Open the review thread." }),
    );
    await act(async () =>
      slot.behavior.setComposerScope({ kind: "thread", threadId: "thr_review" }),
    );
    expect(
      slot.container.querySelector("[data-review-navigation]")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(slot.queryByRole("button")).toBeNull();
    await act(async () =>
      resolveParent(
        makeThreadResponse({
          id: "thr_review",
          originPluginId: "review",
          parentThreadId: "thr_author",
        }),
      ),
    );
    fireEvent.click(slot.getByRole("button", { name: "Back to main thread" }));
    revisiting = true;
    await act(async () =>
      slot.behavior.setComposerScope({ kind: "thread", threadId: "thr_author" }),
    );
    expect(
      slot.container.querySelector("[data-review-navigation]")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(slot.queryByRole("button")).toBeNull();
    await act(async () => resolveChildren([child({ id: "thr_new_review", status: "idle" })]));
    fireEvent.click(
      slot.getByRole("button", { name: "Adversarial review complete. Open the review thread." }),
    );
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_review" },
      { method: "toThread", threadId: "thr_author" },
      { method: "toThread", threadId: "thr_new_review" },
    ]);
  } finally {
    slot.unmount();
  }
});

test("review discovery starts before the thread metadata resolves", async () => {
  let resolveParent!: (thread: ReturnType<typeof makeThreadResponse>) => void;
  const parent = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => {
    resolveParent = resolve;
  });
  const { slot } = await renderBanner(
    async () => [child({ id: "thr_discovered", status: "idle" })],
    async () => parent,
  );
  try {
    expect(slot.inspection.sdkCalls.some((call) => call.method === "threads.list")).toBe(true);
    expect(
      slot.container.querySelector("[data-review-navigation]")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(slot.queryByRole("button")).toBeNull();
    await act(async () => resolveParent(makeThreadResponse({ id: "thr_author" })));
    fireEvent.click(
      slot.getByRole("button", { name: "Adversarial review complete. Open the review thread." }),
    );
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_discovered" },
    ]);
  } finally {
    slot.unmount();
  }
});

for (const sibling of [false, true]) {
  test(`archiving an open review ${sibling ? "retains its sibling's" : "clears its author's"} reservation`, async () => {
    let archivedAt: number | null = null;
    let returning = false;
    let resolveChildren!: (children: Children) => void;
    const returningChildren = new Promise<Children>((resolve) => {
      resolveChildren = resolve;
    });
    const retained = sibling ? [child({ id: "thr_sibling", status: "idle" })] : [];
    const { slot, change } = await renderBanner(
      async (args) =>
        args?.parentThreadId === "thr_review"
          ? []
          : returning
            ? returningChildren
            : [child({ id: "thr_review", status: "idle" }), ...retained],
      async ({ threadId }) =>
        makeThreadResponse({
          id: threadId,
          originPluginId: threadId === "thr_review" ? "review" : null,
          parentThreadId: threadId === "thr_review" ? "thr_author" : null,
          archivedAt: threadId === "thr_review" ? archivedAt : null,
        }),
    );
    try {
      await act(async () =>
        slot.behavior.setComposerScope({ kind: "thread", threadId: "thr_review" }),
      );
      archivedAt = 123;
      await change("thr_review", ["archived-changed"]);
      fireEvent.click(slot.getByRole("button", { name: "Back to main thread" }));
      returning = true;
      await act(async () =>
        slot.behavior.setComposerScope({ kind: "thread", threadId: "thr_author" }),
      );
      const placeholder = slot.container.querySelector("[data-review-navigation]");
      if (sibling) expect(placeholder?.getAttribute("aria-hidden")).toBe("true");
      else expect(placeholder).toBeNull();
      expect(slot.queryByRole("button")).toBeNull();
      await act(async () => resolveChildren(retained));
      if (sibling) {
        fireEvent.click(
          slot.getByRole("button", {
            name: "Adversarial review complete. Open the review thread.",
          }),
        );
      } else expect(slot.container.querySelector("[data-review-navigation]")).toBeNull();
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "thr_author" },
        ...(sibling ? [{ method: "toThread" as const, threadId: "thr_sibling" }] : []),
      ]);
    } finally {
      slot.unmount();
    }
  });
}

test("deleting an open review clears its closed author's reservation before returning", async () => {
  let returning = false;
  let resolveReview!: (thread: ReturnType<typeof makeThreadResponse>) => void;
  const reviewLookup = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => {
    resolveReview = resolve;
  });
  let resolveChildren!: (children: Children) => void;
  const returningChildren = new Promise<Children>((resolve) => {
    resolveChildren = resolve;
  });
  const { slot, change } = await renderBanner(
    async (args) =>
      args?.parentThreadId === "thr_review"
        ? []
        : returning
          ? returningChildren
          : [child({ id: "thr_review", status: "idle" })],
    async ({ threadId }) =>
      threadId === "thr_review" ? reviewLookup : makeThreadResponse({ id: threadId }),
  );
  try {
    await act(async () =>
      slot.behavior.setComposerScope({ kind: "thread", threadId: "thr_review" }),
    );
    await change("thr_review", ["thread-deleted"]);
    await act(async () =>
      resolveReview(
        makeThreadResponse({
          id: "thr_review",
          originPluginId: "review",
          parentThreadId: "thr_author",
        }),
      ),
    );
    expect(slot.queryByRole("button", { name: "Back to main thread" })).toBeNull();
    returning = true;
    await act(async () =>
      slot.behavior.setComposerScope({ kind: "thread", threadId: "thr_author" }),
    );
    expect(slot.container.querySelector("[data-review-navigation]")).toBeNull();
    await act(async () => resolveChildren([]));
    expect(slot.container.querySelector("[data-review-navigation]")).toBeNull();
  } finally {
    slot.unmount();
  }
});

test("moving an open review transfers reserved space from its closed old parent to its new parent", async () => {
  let parentThreadId = "thr_author";
  let returning = false;
  let resolveChildren!: (children: Children) => void;
  const returningChildren = new Promise<Children>((resolve) => {
    resolveChildren = resolve;
  });
  const review = child({ id: "thr_review", status: "idle" });
  const { slot, change } = await renderBanner(
    async (args) =>
      args?.parentThreadId === "thr_review" ? [] : returning ? returningChildren : [review],
    async ({ threadId }) =>
      makeThreadResponse({
        id: threadId,
        originPluginId: threadId === "thr_review" ? "review" : null,
        parentThreadId: threadId === "thr_review" ? parentThreadId : null,
      }),
  );
  try {
    await act(async () =>
      slot.behavior.setComposerScope({ kind: "thread", threadId: "thr_review" }),
    );
    parentThreadId = "thr_new_author";
    await change("thr_review", ["parent-changed"]);
    fireEvent.click(slot.getByRole("button", { name: "Back to main thread" }));
    returning = true;
    await act(async () =>
      slot.behavior.setComposerScope({ kind: "thread", threadId: "thr_author" }),
    );
    expect(slot.container.querySelector("[data-review-navigation]")).toBeNull();
    await act(async () =>
      slot.behavior.setComposerScope({ kind: "thread", threadId: "thr_new_author" }),
    );
    expect(
      slot.container.querySelector("[data-review-navigation]")?.getAttribute("aria-hidden"),
    ).toBe("true");
    await act(async () => resolveChildren([review]));
    fireEvent.click(
      slot.getByRole("button", { name: "Adversarial review complete. Open the review thread." }),
    );
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_new_author" },
      { method: "toThread", threadId: "thr_review" },
    ]);
  } finally {
    slot.unmount();
  }
});

test("the banner requests unarchived reviews and navigates to the retained one", async () => {
  const { slot } = await renderBanner(async (args) =>
    args?.archived === false
      ? [child({ id: "thr_retained", status: "idle", createdAt: 1 })]
      : [child({ id: "thr_archived", status: "idle", createdAt: 2, archivedAt: 3 })],
  );
  try {
    fireEvent.click(
      slot.getByRole("button", { name: "Adversarial review complete. Open the review thread." }),
    );
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_retained" },
    ]);
  } finally {
    slot.unmount();
  }
});

test("a running review opens its thread and remains navigable when it completes", async () => {
  let children = [child({ id: "thr_review", providerId: "claude-code", status: "active" })];
  const { slot, change } = await renderBanner(async () => children);
  try {
    const banner = await slot.findByRole("button", {
      name: "Adversarial review running. Open the review thread.",
    });
    expect(banner.textContent).toContain("claude-code");
    fireEvent.click(banner);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_review" }]);
    expect(slot.inspection.sdkCalls.find((call) => call.method === "threads.list")?.args).toEqual([
      {
        parentThreadId: "thr_author",
        originPluginId: "review",
        includeHidden: true,
        archived: false,
      },
    ]);

    children = [child({ id: "thr_review", status: "idle" })];
    await change("thr_review", ["status-changed"]);
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Adversarial review complete. Open the review thread.",
      }),
    );
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_review" },
      { method: "toThread", threadId: "thr_review" },
    ]);
  } finally {
    slot.unmount();
  }
});

for (const status of ["active", "idle", "error"] as const) {
  test(`an ${status} hidden review's banner returns to its main thread`, async () => {
    const { slot } = await renderBanner(
      async () => [],
      async ({ threadId }) =>
        makeThreadResponse({
          id: threadId,
          originPluginId: "review",
          parentThreadId: "thr_author",
          visibility: "hidden",
          status,
        }),
      "thr_review",
    );
    try {
      fireEvent.click(slot.getByRole("button", { name: "Back to main thread" }));
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "thr_author" },
      ]);
    } finally {
      slot.unmount();
    }
  });
}

for (const connection of ["connecting", "reconnecting"] as const) {
  test(`both banner directions work while realtime is ${connection}`, async () => {
    const { slot } = await renderBanner(
      async () => [child({ id: "thr_review", status: "active" })],
      async ({ threadId }) =>
        makeThreadResponse({
          id: threadId,
          originPluginId: threadId === "thr_review" ? "review" : null,
          parentThreadId: threadId === "thr_review" ? "thr_author" : null,
        }),
      "thr_author",
      connection,
    );
    try {
      fireEvent.click(
        slot.getByRole("button", { name: "Adversarial review running. Open the review thread." }),
      );
      await act(async () =>
        slot.behavior.setComposerScope({ kind: "thread", threadId: "thr_review" }),
      );
      fireEvent.click(slot.getByRole("button", { name: "Back to main thread" }));
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "thr_review" },
        { method: "toThread", threadId: "thr_author" },
      ]);
    } finally {
      slot.unmount();
    }
  });
}

test("a review banner follows a changed parent and hides after detachment", async () => {
  let parentThreadId: string | null = "thr_author";
  const { slot, change } = await renderBanner(
    async () => [],
    async ({ threadId }) =>
      makeThreadResponse({ id: threadId, originPluginId: "review", parentThreadId }),
    "thr_review",
  );
  try {
    fireEvent.click(slot.getByRole("button", { name: "Back to main thread" }));
    parentThreadId = "thr_new_author";
    await change("thr_review", ["parent-changed"]);
    fireEvent.click(slot.getByRole("button", { name: "Back to main thread" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_author" },
      { method: "toThread", threadId: "thr_new_author" },
    ]);
    parentThreadId = null;
    await change("thr_review", ["parent-changed"]);
    expect(slot.queryByRole("button")).toBeNull();
  } finally {
    slot.unmount();
  }
});

test("the same composer can switch from its main thread to the review and back after completion", async () => {
  const { slot } = await renderBanner(
    async () => [child({ id: "thr_review", status: "idle" })],
    async ({ threadId }) =>
      makeThreadResponse({
        id: threadId,
        originPluginId: threadId === "thr_review" ? "review" : null,
        parentThreadId: threadId === "thr_review" ? "thr_author" : null,
      }),
  );
  try {
    fireEvent.click(
      slot.getByRole("button", { name: "Adversarial review complete. Open the review thread." }),
    );
    await act(async () =>
      slot.behavior.setComposerScope({ kind: "thread", threadId: "thr_review" }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Back to main thread" }));
    await act(async () =>
      slot.behavior.setComposerScope({ kind: "thread", threadId: "thr_author" }),
    );
    fireEvent.click(
      slot.getByRole("button", { name: "Adversarial review complete. Open the review thread." }),
    );
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_review" },
      { method: "toThread", threadId: "thr_author" },
      { method: "toThread", threadId: "thr_review" },
    ]);
  } finally {
    slot.unmount();
  }
});

test("the main banner prefers a running review and falls back to the newest finished review", async () => {
  let children = [
    child({ id: "thr_running", status: "active", createdAt: 1 }),
    child({ id: "thr_finished", status: "error", createdAt: 2 }),
  ];
  const { slot, change } = await renderBanner(async () => children);
  try {
    fireEvent.click(
      slot.getByRole("button", { name: "Adversarial review running. Open the review thread." }),
    );
    children = [
      child({ id: "thr_running", status: "error", createdAt: 1 }),
      child({ id: "thr_finished", status: "error", createdAt: 2 }),
    ];
    await change("thr_running", ["status-changed"]);
    fireEvent.click(
      slot.getByRole("button", { name: "Adversarial review failed. Open the review thread." }),
    );
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_running" },
      { method: "toThread", threadId: "thr_finished" },
    ]);
  } finally {
    slot.unmount();
  }
});

test("moving a review refreshes banners when it leaves or joins a parent", async () => {
  let children = [child({ id: "thr_review", status: "active" })];
  const { slot, change } = await renderBanner(async () => children);
  try {
    await slot.findByRole("button");
    children = [];
    await change("thr_review", ["parent-changed"]);
    await waitFor(() => expect(slot.queryByRole("button")).toBeNull());

    children = [child({ id: "thr_incoming_review", status: "active" })];
    await change("thr_incoming_review", ["parent-changed"]);
    fireEvent.click(await slot.findByRole("button"));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_incoming_review" },
    ]);
  } finally {
    slot.unmount();
  }
});

test("completion during discovery cannot install a stale running banner", async () => {
  const existing = child({ id: "thr_existing", status: "active" });
  const discovered = child({ id: "thr_review", status: "active" });
  let resolveDiscovery!: (children: Children) => void;
  const discovery = new Promise<Children>((resolve) => {
    resolveDiscovery = resolve;
  });
  let calls = 0;
  const { slot, change } = await renderBanner(async () => {
    calls += 1;
    if (calls === 1) return [existing];
    if (calls === 2) return discovery;
    return [];
  });
  try {
    await slot.findByRole("button", {
      name: "Adversarial review running. Open the review thread.",
    });
    await change("thr_review", ["thread-created"]);
    await change("thr_review", ["status-changed"]);
    await act(async () => resolveDiscovery([discovered]));

    await waitFor(() => expect(slot.queryByRole("button")).toBeNull());
    expect(calls).toBe(3);
  } finally {
    slot.unmount();
  }
});

test("a status event retries failed discovery and restores the running banner", async () => {
  let calls = 0;
  const { slot, change } = await renderBanner(async () => {
    calls += 1;
    if (calls === 1) throw new Error("Transient connection failure");
    return [child({ id: "thr_review", providerId: "codex", status: "active" })];
  });
  try {
    await change("thr_review", ["status-changed"]);
    const banner = await slot.findByRole("button", {
      name: "Adversarial review running. Open the review thread.",
    });
    expect(banner.textContent).toContain("codex");
  } finally {
    slot.unmount();
  }
});

test("failed discovery after a successful lookup retries on the unknown child's status", async () => {
  let calls = 0;
  const { slot, change } = await renderBanner(async () => {
    calls += 1;
    if (calls === 1) return [];
    if (calls === 2) throw new Error("Transient connection failure");
    return [child({ id: "thr_review", providerId: "codex", status: "active" })];
  });
  try {
    await change("thr_review", ["thread-created"]);
    await change("thr_review", ["status-changed"]);
    const banner = await slot.findByRole("button", {
      name: "Adversarial review running. Open the review thread.",
    });
    expect(banner.textContent).toContain("codex");
    expect(calls).toBe(3);
  } finally {
    slot.unmount();
  }
});

test("a failed completion lookup retries and preserves a link to the finished review", async () => {
  let calls = 0;
  const { slot, change } = await renderBanner(async () => {
    calls += 1;
    if (calls === 1) return [child({ id: "thr_review", status: "active" })];
    if (calls === 2) throw new Error("Transient connection failure");
    return [child({ id: "thr_review", status: "idle" })];
  });
  try {
    await slot.findByRole("button");
    await change("thr_review", ["status-changed"]);
    const button = await slot.findByRole(
      "button",
      {
        name: "Adversarial review complete. Open the review thread.",
      },
      { timeout: 2000 },
    );
    fireEvent.click(button);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_review" }]);
    expect(calls).toBe(3);
  } finally {
    slot.unmount();
  }
});

test("unmount cancels a scheduled retry", async () => {
  let calls = 0;
  const { slot } = await renderBanner(async () => {
    calls += 1;
    throw new Error("Transient connection failure");
  });

  slot.unmount();
  await new Promise((resolve) => setTimeout(resolve, 1100));

  expect(calls).toBe(1);
});

test("the banner shows each review's state, elapsed time, and reviewer by name", async () => {
  const providers = {
    status: "ready",
    providers: [{ id: "codex", displayName: "Codex", logoUrl: null }],
  } as unknown as PluginProvidersState;
  setSystemTime(new Date(200_000));
  let children = [
    child({ id: "thr_review", providerId: "codex", status: "active", createdAt: 125_000 }),
  ];
  const { slot, change } = await renderBanner(
    async () => children,
    undefined,
    undefined,
    "connected",
    providers,
  );
  try {
    const running = await slot.findByRole("button", {
      name: "Adversarial review running. Open the review thread.",
    });
    expect(running.textContent).toBe("Adversarial reviewRunning · 1m 15sCodexOpen");

    children = [child({ id: "thr_review", providerId: "codex", status: "idle" })];
    await change("thr_review", ["status-changed"]);
    const complete = await slot.findByRole("button", {
      name: "Adversarial review complete. Open the review thread.",
    });
    expect(complete.textContent).toBe("Adversarial reviewDoneCodexOpen");

    children = [child({ id: "thr_review", providerId: "codex", status: "error" })];
    await change("thr_review", ["status-changed"]);
    const failed = await slot.findByRole("button", {
      name: "Adversarial review failed. Open the review thread.",
    });
    expect(failed.textContent).toBe("Adversarial reviewFailedCodexOpen");
  } finally {
    slot.unmount();
    setSystemTime();
  }
});
