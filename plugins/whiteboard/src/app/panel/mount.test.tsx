// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest, ApiResponse } from "../../shared/contracts/api-tunnel.ts";
import { queryClient } from "../query.ts";
import type { ReviewCanvasContent, ReviewSourceView } from "../../shared/review-protocol/index.ts";

/**
 * The mount with bb's SDK, the RPC client and the review canvas replaced.
 * What stays real: the bridge, the tunnel, live watch, ReviewApiClient, theme.
 */
const sdk = vi.hoisted(() => ({
  realtime: new Map<string, (payload: unknown) => void>(),
  connection: "connected" as "connected" | "connecting" | "reconnecting",
  context: { projectId: null as string | null, threadId: null as string | null },
  composer: { insert: (_parts: unknown, _options?: unknown) => {}, focus: () => {} },
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
  readGate: undefined as (() => Promise<void>) | undefined,
  commandGate: undefined as (() => Promise<void>) | undefined,
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
  experimental_useCodeTheme: () => ({ mode: "light", name: "light", theme: null }),
  experimental_Icon: ({ name }: { name: string }) => <svg data-icon={name} />,
  useSdk: () => ({
    threads: { get: async () => ({ environment: { hostId: "host-1" } }) },
    system: { config: async () => ({ primaryHostId: "host-1" }) },
  }),
}));

vi.mock("../rpc.ts", () => {
  const api = async (request: ApiRequest): Promise<ApiResponse> => {
    rpcState.calls.push(request);
    const catalog = rpcState.catalog;
    if (request.path.startsWith("/watch")) await rpcState.readGate?.();
    if (request.path === "/commands") await rpcState.commandGate?.();
    if (rpcState.failCommands && request.path === "/commands") {
      return { status: 500, contentType: "application/json", encoding: "utf8", body: "{}" };
    }
    const body = request.path.startsWith("/watch")
      ? `${JSON.stringify([{ value: catalog }])}\n`
      : "{}";
    return { status: 200, contentType: "application/json", encoding: "utf8", body };
  };
  const client = { api };
  return { useWhiteboardRpc: () => client };
});

vi.mock("../review/api-canvas.tsx", () => ({
  ApiCanvas: ({ content }: { content: Extract<ReviewCanvasContent, { kind: "api" }> }) => {
    canvas.content = content;
    return <div data-testid="api-canvas">canvas {content.reviewId}</div>;
  },
}));
/** Most specs list rows with every action; `home.real` renders the real Home and its guards. */
const home = vi.hoisted(() => ({ real: false }));
vi.mock("../review/review-home-view.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../review/review-home-view.tsx")>();
  return {
    ReviewHome: (props: Parameters<typeof actual.ReviewHome>[0]) => {
      if (home.real) return <actual.ReviewHome {...props} />;
      const { reviews, onDismiss, onRestore, onDelete } = props;
      return (
        <ul data-testid="review-home">
          {reviews.map((review) => (
            <li key={review.title}>
              <span>{review.title}</span>
              <span>{review.dismissedAt ? "dismissed" : "active"}</span>
              <button onClick={() => void onDismiss!(review).catch(() => {})}>
                Dismiss {review.title}
              </button>
              <button onClick={() => void onRestore!(review).catch(() => {})}>
                Restore {review.title}
              </button>
              <button onClick={() => void onDelete!(review).catch(() => {})}>
                Delete {review.title}
              </button>
            </li>
          ))}
        </ul>
      );
    },
  };
});
vi.mock("../review/review-find.tsx", () => ({
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
  rpcState.readGate = undefined;
  rpcState.commandGate = undefined;
  home.real = false;
  queryClient.removeQueries({ queryKey: ["whiteboard", "catalog"] });
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
const OTHER = { reviewId: "22222222-2222-4222-8222-222222222222", title: "Other walkthrough" };
/**
 * Start a catalog read that answers today's catalog once released. Another
 * session appears in it, so the bridge delivers it rather than dropping a
 * line identical to the last one.
 */
async function holdCatalogRead() {
  rpcState.catalog = [...rpcState.catalog, { ...OTHER, dismissedAt: null }];
  let release: (() => void) | undefined;
  rpcState.readGate = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  catalogChanged();
  await waitFor(() => expect(release).toBeTypeOf("function"));
  rpcState.readGate = undefined;
  return () => act(async () => release!());
}

describe("WhiteboardMount Home actions", () => {
  it("dismisses before POST resolves, survives a stale catalog, and rolls back failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<WhiteboardMount info={INFO} />);
    await screen.findByText("Auth walkthrough");
    let release!: () => void;
    rpcState.commandGate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Auth walkthrough" }));
    expect(await screen.findByText("dismissed")).toBeTruthy();
    catalogChanged();
    await act(settle);
    expect(await screen.findByText("dismissed")).toBeTruthy();
    rpcState.failCommands = true;
    await waitFor(() => expect(release).toBeTypeOf("function"));
    await act(async () => release());
    await screen.findByText("active");
  });

  it("restores before POST resolves and rolls back failure with a toast", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(toast, "error");
    rpcState.catalog = catalogEntry("2026-10-19T00:00:00Z");
    render(<WhiteboardMount info={INFO} />);
    await screen.findByText("dismissed");
    let release!: () => void;
    rpcState.commandGate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    fireEvent.click(screen.getByRole("button", { name: "Restore Auth walkthrough" }));
    expect(await screen.findByText("active")).toBeTruthy();
    rpcState.failCommands = true;
    await waitFor(() => expect(release).toBeTypeOf("function"));
    await act(async () => release());
    await screen.findByText("dismissed");
    expect(error.mock.calls).toEqual([["Could not restore the Whiteboard. Try again."]]);
  });

  it("deletes before POST resolves and restores the row on failure", async () => {
    render(<WhiteboardMount info={INFO} />);
    await screen.findByText("Auth walkthrough");
    let release!: () => void;
    rpcState.commandGate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    fireEvent.click(screen.getByRole("button", { name: "Delete Auth walkthrough" }));
    await waitFor(() => expect(screen.queryByText("Auth walkthrough")).toBeNull());
    rpcState.failCommands = true;
    await waitFor(() => expect(release).toBeTypeOf("function"));
    await act(async () => release());
    await screen.findByText("Auth walkthrough");
  });

  it("keeps a deleted row gone through Home's guard when an older catalog read lands", async () => {
    home.real = true;
    render(<WhiteboardMount info={INFO} />);
    await screen.findByText("Auth walkthrough");
    const releaseStale = await holdCatalogRead();
    rpcState.catalog = [{ ...OTHER, dismissedAt: null }];
    fireEvent.click(screen.getByRole("button", { name: "Actions for Auth walkthrough" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete Auth walkthrough" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Confirm delete Auth walkthrough" }));
    await waitFor(() => expect(commands()).toEqual([{ type: "delete", reviewId: SESSION }]));
    await act(settle);
    expect(screen.queryByText("Auth walkthrough")).toBeNull();
    await releaseStale();
    await screen.findByText("Other walkthrough");
    expect(screen.queryByText("Auth walkthrough")).toBeNull();
    catalogChanged();
    await act(settle);
    expect(screen.queryByText("Auth walkthrough")).toBeNull();
  });

  it("keeps a restored row active when an older catalog read lands, then follows the server", async () => {
    home.real = true;
    rpcState.catalog = catalogEntry("2026-10-19T00:00:00Z");
    render(<WhiteboardMount info={INFO} />);
    fireEvent.click(await screen.findByRole("button", { name: /Dismissed/ }));
    const releaseStale = await holdCatalogRead();
    rpcState.catalog = [...catalogEntry(null), { ...OTHER, dismissedAt: null }];
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    const actions = { name: "Actions for Auth walkthrough" };
    await screen.findByRole("button", actions);
    await waitFor(() =>
      expect(commands()).toEqual([{ type: "attention", reviewId: SESSION, action: "restore" }]),
    );
    await act(settle);
    await releaseStale();
    await screen.findByText("Other walkthrough");
    expect(screen.getByRole("button", actions)).toBeTruthy();
    // A read after the restore agrees, so the next one shows another device's dismissal.
    catalogChanged();
    await act(settle);
    rpcState.catalog = [...catalogEntry("2026-10-19T00:00:05Z"), { ...OTHER, dismissedAt: null }];
    catalogChanged();
    await waitFor(() => expect(screen.queryByRole("button", actions)).toBeNull());
  });

  it("shows no dismiss error when a queued restore supersedes the failed dismissal", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(toast, "error");
    render(<WhiteboardMount info={INFO} />);
    await screen.findByText("Auth walkthrough");
    let release: (() => void) | undefined;
    rpcState.commandGate = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      rpcState.failCommands = true;
    };
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Auth walkthrough" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore Auth walkthrough" }));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    rpcState.commandGate = async () => {
      rpcState.failCommands = false;
    };
    await act(async () => release!());
    await waitFor(() => expect(commands()).toHaveLength(2));
    await act(settle);
    expect(screen.getByText("active")).toBeTruthy();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("WhiteboardMount", () => {
  it("shows the previous Home list immediately while a return visit refreshes it", async () => {
    const first = render(<WhiteboardMount info={INFO} />);
    await screen.findByText("Auth walkthrough");
    first.unmount();

    let release!: () => void;
    rpcState.readGate = () => new Promise<void>((resolve) => (release = resolve));
    rpcState.catalog = [{ reviewId: SESSION, title: "Updated walkthrough", dismissedAt: null }];
    render(<WhiteboardMount info={INFO} />);
    expect(screen.getByText("Auth walkthrough")).toBeTruthy();
    await waitFor(() => expect(release).toBeTypeOf("function"));
    await act(async () => release());
    expect(await screen.findByText("Updated walkthrough")).toBeTruthy();
    expect(screen.queryByText("Auth walkthrough")).toBeNull();
  });

  it("does not reuse another thread's Home list while its own read is pending", async () => {
    const first = render(<WhiteboardMount threadId="thread-1" info={INFO} />);
    await screen.findByText("Auth walkthrough");
    first.unmount();

    let release!: () => void;
    rpcState.readGate = () => new Promise<void>((resolve) => (release = resolve));
    rpcState.catalog = [{ reviewId: SESSION, title: "Another thread's pad", dismissedAt: null }];
    render(<WhiteboardMount threadId="thread-2" info={INFO} />);
    expect(screen.queryByText("Auth walkthrough")).toBeNull();
    await waitFor(() => expect(release).toBeTypeOf("function"));
    await act(async () => release());
    expect(await screen.findByText("Another thread's pad")).toBeTruthy();
  });

  it("does not let an unmounted Home's late read replace a newer cached list", async () => {
    let release!: () => void;
    rpcState.readGate = () => new Promise<void>((resolve) => (release = resolve));
    const previous = render(<WhiteboardMount info={INFO} />);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    previous.unmount();

    rpcState.readGate = undefined;
    rpcState.commandGate = undefined;
    rpcState.catalog = [{ reviewId: SESSION, title: "Newer walkthrough", dismissedAt: null }];
    render(<WhiteboardMount info={INFO} />);
    await screen.findByText("Newer walkthrough");
    await act(async () => release());
    await settle();
    expect(screen.getByText("Newer walkthrough")).toBeTruthy();
    expect(screen.queryByText("Auth walkthrough")).toBeNull();
  });

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
  it("renders the review CSS scope root in bb's light scope while bb is dark", async () => {
    render(<WhiteboardMount sessionId={SESSION} threadId="thread-1" info={INFO} />);
    await screen.findByTestId("api-canvas");
    expect(document.documentElement.className).toBe("dark");
    expect(root().parentElement!.className).toBe("light");
    expect(root().dataset.reviewTheme).toBe("light");
    expect(themeHost().className).toBe("review-theme-host review-app--theme-light");
    expect(root().contains(screen.getByTestId("api-canvas"))).toBe(true);
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
    const insert = vi.spyOn(sdk.composer, "insert");
    const focus = vi.spyOn(sdk.composer, "focus");
    const toCompose = vi.spyOn(sdk.navigate, "toCompose");
    const handoff = (quote: string) => ({ quote, sessionId: SESSION, version: 2, title: "Auth" });
    const pill = { provider: "session", id: `${SESSION}@2`, label: "Auth" };
    const atEnd = { at: "end", block: true };
    const thread = render(<WhiteboardMount sessionId={SESSION} threadId="thread-1" info={INFO} />);
    const threadCanvas = await screen.findByTestId("api-canvas");
    expect(await copyText("agent context", handoff("quote text"), threadCanvas)).toBe(true);
    expect(insert.mock.calls).toEqual([[["> quote text\n", pill, " "], atEnd]]);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(toCompose).not.toHaveBeenCalled();
    thread.unmount();

    render(<WhiteboardMount sessionId={SESSION} info={INFO} />);
    const pageCanvas = await screen.findByTestId("api-canvas");
    expect(await copyText("agent context", handoff("from the full page"), pageCanvas)).toBe(true);
    expect(insert.mock.calls).toEqual([
      [["> quote text\n", pill, " "], atEnd],
      [["> from the full page\n", pill, " "], atEnd],
    ]);
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
