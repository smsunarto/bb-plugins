import { afterEach, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Isolate module mocks in a child process so they never leak to other test files.
if (!process.env.BB_AGENTATION_LAZY_INIT_CHILD) {
  test("toolbar overlay lazy initialization", () => {
    const child = spawnSync(process.execPath, ["test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, BB_AGENTATION_LAZY_INIT_CHILD: "1" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(child.status, child.stderr).toBe(0);
  });
} else {
  const { installDom } = await import("@bb-plugins/testing");
  installDom();
  const jsdomWindow = window as unknown as {
    AbortController: typeof AbortController;
    AbortSignal: typeof AbortSignal;
  };
  Object.assign(globalThis, {
    AbortController: jsdomWindow.AbortController,
    AbortSignal: jsdomWindow.AbortSignal,
  });
  const { createElement } = await import("react");
  const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");

  let agentationRenderCount = 0;
  let lastAgentationActive: boolean | undefined;
  let openedStreams = 0;
  const openSessionCalls: string[] = [];

  class FakeEventSource extends EventTarget {
    readyState = 1;
    constructor() {
      super();
      openedStreams += 1;
    }
    close() {
      this.readyState = 2;
    }
  }
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    writable: true,
    value: FakeEventSource,
  });

  const storedByRoute = new Map<string, unknown[]>();
  mock.module("../vendor/agentation/dist/index.mjs", () => ({
    Agentation: (props: { active?: boolean }) => {
      agentationRenderCount += 1;
      lastAgentationActive = props.active;
      return createElement("div", {
        "data-testid": "fake-agentation",
        "data-active": String(props.active),
      });
    },
    loadAnnotations: (route: string) => storedByRoute.get(route) ?? [],
    saveAnnotations: (route: string, items: unknown[]) => {
      storedByRoute.set(route, items);
    },
  }));

  mock.module("../lib/plugin-rpc.ts", () => ({
    createRpcClient: () => ({
      call: async (method: string, input: Record<string, unknown>) => {
        if (method === "openSession") {
          const route = String(input.route);
          openSessionCalls.push(route);
          return {
            session: { id: `session:${route}` },
            annotations: [],
            cursor: 1,
            config: { toolbarEnabled: true },
          };
        }
        if (method === "pullSession") {
          return {
            cursor: 1,
            changed: false,
            config: { toolbarEnabled: true },
          };
        }
        throw new Error(`Unexpected RPC ${method}`);
      },
    }),
  }));

  const { AnnotationToolbarOverlay } = await import("../components/annotation-toolbar.tsx");
  const { activateFeedbackMode, setFeedbackModeActive } = await import("../lib/feedback-mode.ts");

  afterEach(() => {
    cleanup();
    setFeedbackModeActive(false);
    storedByRoute.clear();
    openSessionCalls.length = 0;
    agentationRenderCount = 0;
    lastAgentationActive = undefined;
    openedStreams = 0;
    window.history.replaceState(null, "", "/");
  });

  test("inactive with no local annotations makes 0 openSession/SSE calls and does not mount Agentation", async () => {
    render(createElement(AnnotationToolbarOverlay));
    await act(async () => {
      await Promise.resolve();
    });

    expect(openSessionCalls).toEqual([]);
    expect(openedStreams).toBe(0);
    expect(agentationRenderCount).toBe(0);

    // Activating feedback mode lazily starts the toolbar, opens a session, and connects SSE.
    act(() => {
      activateFeedbackMode();
    });
    await waitFor(() => expect(openSessionCalls).toEqual(["/"]));
    expect(openedStreams).toBe(1);
    expect(agentationRenderCount).toBeGreaterThan(0);
    expect(lastAgentationActive).toBe(true);
  });

  test("Mod+Shift+F while idle activates feedback mode and mounts Agentation", async () => {
    render(createElement(AnnotationToolbarOverlay));
    await act(async () => {
      await Promise.resolve();
    });
    expect(openSessionCalls).toEqual([]);
    expect(agentationRenderCount).toBe(0);

    fireEvent.keyDown(document, { key: "F", shiftKey: true, ctrlKey: true });
    await waitFor(() => expect(openSessionCalls).toEqual(["/"]));
    expect(openedStreams).toBe(1);
    expect(lastAgentationActive).toBe(true);
  });

  test("local annotations on the current route engage the toolbar even while inactive", async () => {
    storedByRoute.set("/", [{ id: "ann_local", comment: "existing" }]);
    render(createElement(AnnotationToolbarOverlay));

    await waitFor(() => expect(openSessionCalls).toEqual(["/"]));
    expect(openedStreams).toBe(1);
    expect(agentationRenderCount).toBeGreaterThan(0);
    expect(lastAgentationActive).toBe(false);
  });
}
