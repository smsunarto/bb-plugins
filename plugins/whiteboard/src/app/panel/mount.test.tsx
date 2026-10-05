// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest, ApiResponse } from "../../shared/contracts/api-tunnel.ts";
import type {
  ReviewCanvasContent,
  ReviewSourceView,
} from "../../shared/vendor/review-protocol/src/index.ts";

/**
 * The mount with bb's SDK, the RPC client and the vendored canvas replaced.
 * What stays real: the bridge, the tunnel, live watch, ReviewApiClient, theme.
 */
const sdk = vi.hoisted(() => ({
  realtime: new Map<string, (payload: unknown) => void>(),
  connection: "connected" as "connected" | "connecting" | "reconnecting",
  context: { projectId: null as string | null, threadId: null as string | null },
  composer: { addQuote: (_text: string) => {}, insertMention: (_mention: unknown) => {} },
  navigate: {
    toPluginPanel: (_path: string, _options?: unknown) => {},
    toCompose: (_options?: unknown) => {},
    openThreadPanel: () => true,
    openUrl: () => true,
    experimental_openFilePreview: () => true,
  },
}));
const rpcState = vi.hoisted(() => ({
  catalog: [] as Array<{ reviewId: string; title: string; dismissedAt: string | null }>,
  calls: [] as ApiRequest[],
  failCommands: false,
}));
const find = vi.hoisted(() => ({ showFind: (_seed?: string) => true as boolean }));
const canvas = vi.hoisted(() => ({
  content: undefined as Extract<ReviewCanvasContent, { kind: "api" }> | undefined,
  sourceView: undefined as (() => ReviewSourceView | undefined) | undefined,
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useBbContext: () => sdk.context,
  useBbNavigate: () => sdk.navigate,
  useRealtime: (channel: string, handler: (payload: unknown) => void) => {
    sdk.realtime.set(channel, handler);
  },
  useRealtimeConnectionState: () => sdk.connection,
  useComposer: () => sdk.composer,
  experimental_Icon: ({ name }: { name: string }) => <svg data-icon={name} />,
  useSdk: () => ({
    threads: { get: async () => ({ environment: { hostId: "host-1" } }) },
    system: { config: async () => ({ primaryHostId: "host-1" }) },
  }),
}));

vi.mock("../rpc.ts", () => {
  const api = async (request: ApiRequest): Promise<ApiResponse> => {
    rpcState.calls.push(request);
    if (rpcState.failCommands && request.path === "/commands") {
      return { status: 500, contentType: "application/json", encoding: "utf8", body: "{}" };
    }
    const body = request.path.startsWith("/watch")
      ? `${JSON.stringify([{ value: rpcState.catalog }])}\n`
      : "{}";
    return { status: 200, contentType: "application/json", encoding: "utf8", body };
  };
  const client = { api };
  return { rpc: { useClient: () => client } };
});

vi.mock("../vendor/review/app/src/api-canvas.tsx", () => ({
  ApiCanvas: ({ content }: { content: Extract<ReviewCanvasContent, { kind: "api" }> }) => {
    canvas.content = content;
    return <div data-testid="api-canvas">canvas {content.reviewId}</div>;
  },
}));
vi.mock("../vendor/review/app/src/review-home-view.tsx", () => ({
  ReviewHome: ({ reviews }: { reviews: Array<{ title: string }> }) => (
    <ul data-testid="review-home">
      {reviews.map((review) => (
        <li key={review.title}>{review.title}</li>
      ))}
    </ul>
  ),
}));
vi.mock("../vendor/review/app/src/review-find.tsx", () => ({
  createReviewFindHost: () => ({
    attach() {},
    showFind: (seed?: string) => find.showFind(seed),
    hideFind() {},
  }),
}));
// WP6 owns these; the mount only needs their factory shapes.
vi.mock("../bridge/inline-editors.tsx", () => ({ createInlineEditors: () => ({}) }));
vi.mock("../bridge/diff-view.tsx", () => ({
  createDiffView: ({ sourceView }: { sourceView: () => ReviewSourceView | undefined }) => {
    canvas.sourceView = sourceView;
    return { files: async () => [] };
  },
}));

const { WhiteboardMount } = await import("./mount.tsx");
const { copyText } = await import("../bridge/agent-handoff.ts");

const INFO = {
  appVersion: "1.0.0",
  softwareMapEnabled: false,
  scratchpadEnabled: false,
  structuralDiffEnabled: false,
};
const SESSION = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  document.documentElement.className = "dark";
  rpcState.catalog = [{ reviewId: SESSION, title: "Auth walkthrough", dismissedAt: null }];
  rpcState.calls = [];
  rpcState.failCommands = false;
  sdk.realtime.clear();
  sdk.connection = "connected";
  sdk.context = { projectId: null, threadId: null };
  canvas.content = undefined;
  canvas.sourceView = undefined;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.getSelection()?.removeAllRanges();
  document.documentElement.className = "";
});

const root = () => document.querySelector<HTMLElement>(".review-canvas-root")!;
const themeHost = () => root().querySelector<HTMLElement>(".review-theme-host")!;
const watchCalls = () => rpcState.calls.filter((call) => call.path.startsWith("/watch")).length;
const commands = () =>
  rpcState.calls
    .filter((call) => call.path === "/commands")
    .map((call) => JSON.parse(call.body!).operation);
const catalogChanged = () =>
  act(() => sdk.realtime.get("whiteboard:changed")!({ kind: "catalog" }));
const catalogEntry = (dismissedAt: string | null) => [
  { reviewId: SESSION, title: "Auth walkthrough", dismissedAt },
];
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("WhiteboardMount", () => {
  it("preserves current source generation and strips it for a historical address", async () => {
    render(<WhiteboardMount sessionId={SESSION} threadId="thread-1" info={INFO} />);
    await screen.findByTestId("api-canvas");
    const content = canvas.content!;
    content.setSourceView!(
      { kind: "current", reviewId: SESSION },
      {
        reviewId: SESSION,
        version: 3,
        generation: "live-generation",
      },
    );
    await content.bridge.diffView.files();
    expect(canvas.sourceView!()).toEqual({
      reviewId: SESSION,
      version: 3,
      generation: "live-generation",
    });
    content.setSourceView!(
      { kind: "version", reviewId: SESSION, version: 1 },
      {
        reviewId: SESSION,
        version: 1,
        generation: "saved-generation",
      },
    );
    expect(canvas.sourceView!()).toEqual({ reviewId: SESSION, version: 1, generation: undefined });
  });
  it("renders the vendored CSS scope root and follows bb's theme", async () => {
    render(<WhiteboardMount sessionId={SESSION} threadId="thread-1" info={INFO} />);
    await screen.findByTestId("api-canvas");
    expect(root().dataset.reviewTheme).toBe("dark");
    expect(themeHost().className).toBe("review-theme-host");
    expect(root().contains(screen.getByTestId("api-canvas"))).toBe(true);

    await act(async () => {
      document.documentElement.classList.remove("dark");
      await Promise.resolve();
    });
    expect(root().dataset.reviewTheme).toBe("light");
    expect(themeHost().className).toBe("review-theme-host review-app--theme-light");
  });

  it("marks the session viewed when it opens", async () => {
    render(<WhiteboardMount sessionId={SESSION} threadId="thread-1" info={INFO} />);
    await waitFor(() =>
      expect(rpcState.calls.some((call) => call.path === "/commands")).toBe(true),
    );
    const post = rpcState.calls.find((call) => call.path === "/commands")!;
    expect(post.method).toBe("POST");
    expect(post.threadId).toBe("thread-1");
    expect(JSON.parse(post.body!).operation).toEqual({
      type: "attention",
      reviewId: SESSION,
      action: "view",
    });
  });

  it("opens Whiteboard find on Cmd+F only inside the panel", async () => {
    const showFind = vi.fn((_seed?: string) => true);
    find.showFind = showFind;
    render(<WhiteboardMount sessionId={SESSION} threadId="thread-1" info={INFO} />);
    await screen.findByTestId("api-canvas");

    const outside = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(outside);
    expect(showFind).not.toHaveBeenCalled();
    expect(outside.defaultPrevented).toBe(false);

    const inside = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    screen.getByTestId("api-canvas").dispatchEvent(inside);
    expect(showFind).toHaveBeenCalledTimes(1);
    expect(inside.defaultPrevented).toBe(true);

    const withShift = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    screen.getByTestId("api-canvas").dispatchEvent(withShift);
    expect(showFind).toHaveBeenCalledTimes(1);
  });

  it("leaves Cmd+F to bb when find does not open", async () => {
    find.showFind = () => false;
    render(<WhiteboardMount sessionId={SESSION} threadId="thread-1" info={INFO} />);
    await screen.findByTestId("api-canvas");
    const event = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    screen.getByTestId("api-canvas").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("shows the removed state when the session leaves the catalog", async () => {
    render(<WhiteboardMount sessionId={SESSION} threadId="thread-1" info={INFO} />);
    await screen.findByTestId("api-canvas");
    rpcState.catalog = [];
    catalogChanged();
    expect(await screen.findByText("This Whiteboard was removed.")).toBeTruthy();
  });

  it("returns the full page to Home when its session is dismissed", async () => {
    const toPluginPanel = vi.spyOn(sdk.navigate, "toPluginPanel");
    render(<WhiteboardMount sessionId={SESSION} info={INFO} />);
    await screen.findByTestId("api-canvas");

    rpcState.catalog = catalogEntry("2026-09-30T01:00:00.000Z");
    catalogChanged();
    await waitFor(() =>
      expect(toPluginPanel.mock.calls).toEqual([["whiteboard", { subPath: "", replace: true }]]),
    );
    expect(screen.queryByText("Whiteboard dismissed.")).toBeNull();
  });

  it("keeps the full page open beside a focused thread pane, and through Undo", async () => {
    const toPluginPanel = vi.spyOn(sdk.navigate, "toPluginPanel");
    sdk.context = { projectId: "project-1", threadId: "thread-9" };
    const view = render(<WhiteboardMount sessionId={SESSION} info={INFO} />);
    await screen.findByTestId("api-canvas");

    rpcState.catalog = catalogEntry("2026-09-30T01:00:00.000Z");
    catalogChanged();
    expect(await screen.findByText("Whiteboard dismissed.")).toBeTruthy();

    // Pressing Undo focuses this pane first, which moves the route here.
    sdk.context = { projectId: null, threadId: null };
    view.rerender(<WhiteboardMount sessionId={SESSION} info={INFO} />);
    rpcState.calls = [];
    act(() => screen.getByRole("button", { name: "Undo" }).click());
    await waitFor(() =>
      expect(commands()).toEqual([{ type: "attention", reviewId: SESSION, action: "restore" }]),
    );
    expect(toPluginPanel).not.toHaveBeenCalled();
  });

  it("tells the user when Undo cannot restore the session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(toast, "error");
    render(<WhiteboardMount sessionId={SESSION} threadId="thread-1" info={INFO} />);
    await screen.findByTestId("api-canvas");
    rpcState.catalog = catalogEntry("2026-09-30T01:00:00.000Z");
    catalogChanged();
    await screen.findByText("Whiteboard dismissed.");

    rpcState.failCommands = true;
    act(() => screen.getByRole("button", { name: "Undo" }).click());
    await waitFor(() =>
      expect(error.mock.calls).toEqual([["Could not restore the Whiteboard. Try again."]]),
    );
    expect(screen.getByText("Whiteboard dismissed.")).toBeTruthy();
  });

  it("keeps a thread tab opened while dismissed, then offers Undo once it is re-dismissed", async () => {
    const toPluginPanel = vi.spyOn(sdk.navigate, "toPluginPanel");
    rpcState.catalog = catalogEntry("2026-09-30T00:00:00.000Z");
    render(<WhiteboardMount sessionId={SESSION} threadId="thread-1" info={INFO} />);
    await screen.findByTestId("api-canvas");
    catalogChanged();
    await settle();
    expect(screen.queryByText("Whiteboard dismissed.")).toBeNull();

    rpcState.catalog = catalogEntry(null);
    catalogChanged();
    await settle();
    expect(screen.getByTestId("api-canvas")).toBeTruthy();

    rpcState.catalog = catalogEntry("2026-09-30T01:00:00.000Z");
    catalogChanged();
    expect(await screen.findByText("Whiteboard dismissed.")).toBeTruthy();
    expect(screen.getByText("It stays under Dismissed on Whiteboard Home.")).toBeTruthy();
    expect(toPluginPanel).not.toHaveBeenCalled();

    rpcState.calls = [];
    act(() => screen.getByRole("button", { name: "Undo" }).click());
    await waitFor(() =>
      expect(commands()).toEqual([{ type: "attention", reviewId: SESSION, action: "restore" }]),
    );
  });

  it("adds a canvas selection to the thread composer, or to bb compose from the full page", async () => {
    const addQuote = vi.spyOn(sdk.composer, "addQuote");
    const insertMention = vi.spyOn(sdk.composer, "insertMention");
    const toCompose = vi.spyOn(sdk.navigate, "toCompose");
    const handoff = (quote: string) => ({ quote, sessionId: SESSION, version: 2, title: "Auth" });
    const pill = { provider: "session", id: `${SESSION}@2`, label: "Auth" };
    const thread = render(<WhiteboardMount sessionId={SESSION} threadId="thread-1" info={INFO} />);
    const threadCanvas = await screen.findByTestId("api-canvas");
    expect(await copyText("agent context", handoff("quote text"), threadCanvas)).toBe(true);
    expect(addQuote.mock.calls).toEqual([["quote text"]]);
    expect(insertMention.mock.calls).toEqual([[pill]]);
    expect(toCompose).not.toHaveBeenCalled();
    thread.unmount();

    render(<WhiteboardMount sessionId={SESSION} info={INFO} />);
    const pageCanvas = await screen.findByTestId("api-canvas");
    expect(await copyText("agent context", handoff("from the full page"), pageCanvas)).toBe(true);
    expect(addQuote.mock.calls).toEqual([["quote text"], ["from the full page"]]);
    expect(insertMention.mock.calls).toEqual([[pill], [pill]]);
    expect(toCompose.mock.calls).toEqual([[{ focusPrompt: true }]]);
  });

  it("refetches live streams after a realtime reconnect", async () => {
    const view = render(<WhiteboardMount info={INFO} />);
    await screen.findByText("Auth walkthrough");
    const before = watchCalls();

    sdk.connection = "reconnecting";
    view.rerender(<WhiteboardMount info={INFO} />);
    rpcState.catalog = [
      ...rpcState.catalog,
      { reviewId: "22222222-2222-4222-8222-222222222222", title: "Billing", dismissedAt: null },
    ];
    sdk.connection = "connected";
    view.rerender(<WhiteboardMount info={INFO} />);

    expect(await screen.findByText("Billing")).toBeTruthy();
    expect(watchCalls()).toBe(before + 1);
  });

  it("ignores malformed realtime payloads", async () => {
    render(<WhiteboardMount info={INFO} />);
    await screen.findByText("Auth walkthrough");
    const before = watchCalls();
    act(() => sdk.realtime.get("whiteboard:changed")!({ kind: "nope" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(watchCalls()).toBe(before);
  });
});
