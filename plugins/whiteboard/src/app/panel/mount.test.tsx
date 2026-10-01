// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest, ApiResponse } from "../../shared/contracts/api-tunnel.ts";

/**
 * The mount with bb's SDK, the RPC client and the vendored canvas replaced.
 * What stays real: the bridge, the tunnel, live watch, ReviewApiClient, theme.
 */
const sdk = vi.hoisted(() => ({
  realtime: new Map<string, (payload: unknown) => void>(),
  connection: "connected" as "connected" | "connecting" | "reconnecting",
  navigate: {
    toPluginPanel: () => {},
    openThreadPanel: () => true,
    openUrl: () => true,
    experimental_openFilePreview: () => true,
  },
}));
const rpcState = vi.hoisted(() => ({
  catalog: [] as Array<{ reviewId: string; title: string; dismissedAt: string | null }>,
  calls: [] as ApiRequest[],
}));
const find = vi.hoisted(() => ({ showFind: (_seed?: string) => true as boolean }));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useBbNavigate: () => sdk.navigate,
  useRealtime: (channel: string, handler: (payload: unknown) => void) => {
    sdk.realtime.set(channel, handler);
  },
  useRealtimeConnectionState: () => sdk.connection,
  experimental_Icon: ({ name }: { name: string }) => <svg data-icon={name} />,
  useSdk: () => ({
    threads: { get: async () => ({ environment: { hostId: "host-1" } }) },
    system: { config: async () => ({ primaryHostId: "host-1" }) },
  }),
}));

vi.mock("../rpc.ts", () => {
  const api = async (request: ApiRequest): Promise<ApiResponse> => {
    rpcState.calls.push(request);
    const body = request.path.startsWith("/watch")
      ? `${JSON.stringify([{ value: rpcState.catalog }])}\n`
      : "{}";
    return { status: 200, contentType: "application/json", encoding: "utf8", body };
  };
  const client = { api };
  return { rpc: { useClient: () => client } };
});

vi.mock("../vendor/review/app/src/api-canvas.tsx", () => ({
  ApiCanvas: ({ content }: { content: { reviewId: string } }) => (
    <div data-testid="api-canvas">canvas {content.reviewId}</div>
  ),
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
vi.mock("../bridge/diff-view.tsx", () => ({ createDiffView: () => ({}) }));

const { REMOVED_TITLE, WhiteboardMount } = await import("./mount.tsx");

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
  sdk.realtime.clear();
  sdk.connection = "connected";
});

afterEach(() => {
  cleanup();
  document.documentElement.className = "";
});

const root = () => document.querySelector<HTMLElement>(".review-canvas-root")!;
const themeHost = () => root().querySelector<HTMLElement>(".review-theme-host")!;
const watchCalls = () => rpcState.calls.filter((call) => call.path.startsWith("/watch")).length;

describe("WhiteboardMount", () => {
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
    act(() => sdk.realtime.get("whiteboard:changed")!({ kind: "catalog" }));
    expect(await screen.findByText(REMOVED_TITLE)).toBeTruthy();
  });

  it("closes on dismiss, but keeps a session opened while dismissed until it is re-dismissed", async () => {
    const changed = () => act(() => sdk.realtime.get("whiteboard:changed")!({ kind: "catalog" }));
    const entry = (dismissedAt: string | null) => [
      { reviewId: SESSION, title: "Auth walkthrough", dismissedAt },
    ];

    rpcState.catalog = entry("2026-09-30T00:00:00.000Z");
    render(<WhiteboardMount sessionId={SESSION} threadId="thread-1" info={INFO} />);
    await screen.findByTestId("api-canvas");
    changed();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText(REMOVED_TITLE)).toBeNull();

    rpcState.catalog = entry(null);
    changed();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByTestId("api-canvas")).toBeTruthy();

    rpcState.catalog = entry("2026-09-30T01:00:00.000Z");
    changed();
    expect(await screen.findByText(REMOVED_TITLE)).toBeTruthy();
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
