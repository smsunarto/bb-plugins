import { afterEach, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Isolate module mocks in a child process so they never leak to other test files.
if (!process.env.BB_AGENTATION_STAGED_PERF_CHILD) {
  test("staged annotations empty-batch draft isolation and narrow observer", () => {
    const child = spawnSync(process.execPath, ["test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, BB_AGENTATION_STAGED_PERF_CHILD: "1" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(child.status, child.stderr).toBe(0);
  });
} else {
  const { installDom } = await import("@bb-plugins/testing");
  installDom();
  const { createElement, useSyncExternalStore } = await import("react");
  const { act, cleanup, render, waitFor } = await import("@testing-library/react");

  const realSdk = await import("@get-bb/plugin-sdk/app");

  const tracker = {
    draftText: "",
    draftReadCount: 0,
    draftSubscribed: false,
    rpcAnnotations: [] as unknown[],
    rpcCalls: 0,
  };
  const draftListeners = new Set<() => void>();

  function setDraftText(next: string) {
    tracker.draftText = next;
    if (tracker.draftSubscribed) {
      for (const listener of draftListeners) listener();
    }
  }

  function createTrackedComposerProxy() {
    return new Proxy(
      {
        scope: { kind: "thread", threadId: "thr_perf" } as const,
        onSubmitted: () => () => {},
        insert: () => {},
        replace: () => {},
        focus: () => {},
        submit: async () => {},
      },
      {
        get(target, prop, receiver) {
          if (prop === "draft") {
            tracker.draftReadCount += 1;
            tracker.draftSubscribed = true;
            return { text: tracker.draftText, mentions: [] };
          }
          return Reflect.get(target, prop, receiver);
        },
      },
    );
  }

  // Mimics BB's useComposer() proxy: reading `.draft` subscribes the caller to draft updates.
  function useTrackedComposer() {
    useSyncExternalStore(
      (listener) => {
        draftListeners.add(listener);
        return () => draftListeners.delete(listener);
      },
      () => (tracker.draftSubscribed ? tracker.draftText : "untracked"),
    );
    return createTrackedComposerProxy();
  }

  const fakeRpc = {
    call: async (method: string) => {
      if (method === "listStagedAnnotations") {
        tracker.rpcCalls += 1;
        return { annotations: tracker.rpcAnnotations, threadTitles: {} };
      }
      throw new Error(`Unexpected RPC ${method}`);
    },
  };

  mock.module("@get-bb/plugin-sdk/app", () => ({
    ...realSdk,
    experimental_usePluginId: () => "agentation",
    useComposer: useTrackedComposer,
    useRealtime: () => {},
    useRealtimeConnectionState: () => "connected",
    useRpc: () => fakeRpc,
  }));

  const { AgentationStagedAnnotationsAction } =
    await import("../components/staged-annotations-action.tsx");

  const OriginalMutationObserver = globalThis.MutationObserver;
  let observerInstances = 0;
  let observerCallbacks = 0;
  class CountingMutationObserver extends OriginalMutationObserver {
    constructor(callback: MutationCallback) {
      super((records, obs) => {
        observerCallbacks += 1;
        callback(records, obs);
      });
      observerInstances += 1;
    }
  }
  Object.defineProperty(globalThis, "MutationObserver", {
    configurable: true,
    writable: true,
    value: CountingMutationObserver,
  });

  afterEach(() => {
    cleanup();
    tracker.draftText = "";
    tracker.draftReadCount = 0;
    tracker.draftSubscribed = false;
    tracker.rpcAnnotations = [];
    tracker.rpcCalls = 0;
    observerInstances = 0;
    observerCallbacks = 0;
  });

  test("empty staged batch never reads composer.draft and creates no MutationObserver", async () => {
    let parentRenders = 0;
    function ComposerShell() {
      parentRenders += 1;
      return createElement(
        "form",
        { "data-promptbox": "" },
        createElement(
          "div",
          { "data-t3-attachments": "" },
          createElement("span", { "data-composer-context-slot": "" }),
        ),
        createElement(
          "div",
          { "data-promptbox-editor-scroll": "" },
          createElement("div", { contentEditable: "true" }),
        ),
        createElement(
          "div",
          { "data-plugin-composer-action": "" },
          createElement(AgentationStagedAnnotationsAction),
        ),
      );
    }

    render(createElement(ComposerShell));
    await waitFor(() => expect(tracker.rpcCalls).toBe(1));
    await act(async () => {});

    expect(tracker.draftReadCount).toBe(0);
    expect(tracker.draftSubscribed).toBe(false);
    expect(observerInstances).toBe(0);

    const rendersBeforeTyping = parentRenders;
    act(() => {
      setDraftText("h");
      setDraftText("he");
      setDraftText("hello");
    });
    expect(tracker.draftReadCount).toBe(0);
    expect(parentRenders).toBe(rendersBeforeTyping);
  });

  test("non-empty staged batch observes narrow wrapper so editor mutations do not fire observer", async () => {
    tracker.rpcAnnotations = [
      {
        id: "ann_1",
        comment: "Fix spacing",
        element: "button",
        elementPath: "main > button",
        timestamp: 1,
        sessionId: "ses_1",
        status: "pending",
        kind: "feedback",
        thread: [],
        bb: { route: "/settings", routeLabel: "Settings", threadId: null, pluginId: null },
        createdAt: "2026-10-23T00:00:00.000Z",
        updatedAt: "2026-10-23T00:00:00.000Z",
        resolution: null,
        seq: 1,
      },
    ];

    const view = render(
      createElement(
        "form",
        { "data-promptbox": "" },
        createElement(
          "div",
          { "data-t3-attachments": "" },
          createElement("span", { "data-composer-context-slot": "" }),
        ),
        createElement(
          "div",
          { "data-promptbox-editor-scroll": "" },
          createElement("div", { contentEditable: "true", "data-testid": "editor" }),
        ),
        createElement(
          "div",
          { "data-plugin-composer-action": "" },
          createElement(AgentationStagedAnnotationsAction),
        ),
      ),
    );

    await waitFor(() =>
      expect(view.queryByRole("button", { name: "1 annotation" })).not.toBeNull(),
    );
    expect(observerInstances).toBe(1);
    const callbacksBeforeTyping = observerCallbacks;

    // Simulate ProseMirror mutating child nodes inside the editor scroll container.
    const editor = view.getByTestId("editor");
    act(() => {
      for (let i = 0; i < 10; i++) {
        const p = document.createElement("p");
        p.textContent = `line ${i}`;
        editor.appendChild(p);
      }
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(observerCallbacks).toBe(callbacksBeforeTyping);
  });
}
