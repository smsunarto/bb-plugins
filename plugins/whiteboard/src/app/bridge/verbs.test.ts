import type { BbNavigate } from "@get-bb/plugin-sdk/app";
import { describe, expect, it, vi } from "vitest";
import { REVIEW_DISCORD_URL } from "../../shared/vendor/review-protocol/src/index.ts";
import { createSurfaceEvents } from "./events.ts";
import {
  PINNED_SOURCE_NOT_OPENABLE,
  SESSION_NOT_FOUND,
  SOURCE_TREE_UNAVAILABLE,
  UNAVAILABLE_IN_BB,
  type VerbDeps,
  createVerbs,
} from "./verbs.ts";

function navigateMock() {
  return {
    toPluginPanel: vi.fn(),
    openThreadPanel: vi.fn(() => true),
    openUrl: vi.fn(() => true),
    experimental_openFilePreview: vi.fn(() => true),
  };
}

function setup(overrides: Partial<VerbDeps> = {}, routes: Record<string, unknown> = {}) {
  const navigate = navigateMock();
  const events = createSurfaceEvents();
  const emitted: unknown[] = [];
  events.subscribe((event) => emitted.push(event));
  const request = vi.fn(async (url: string) => {
    const route = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    return route ? Response.json(routes[route]) : Response.json({ error: "no" }, { status: 404 });
  });
  const deps: VerbDeps = {
    navigate: navigate as unknown as BbNavigate,
    threadId: "thread-1",
    reviewId: "session-1",
    request,
    events,
    notify: vi.fn(),
    revealDiffFile: vi.fn(),
    resolveHostId: async () => "host-1",
    softwareMapEnabled: () => true,
    ...overrides,
  };
  return { post: createVerbs(deps), deps, navigate, emitted, request };
}

describe("createVerbs", () => {
  it("reports authoring capabilities from the live flag", async () => {
    let enabled = false;
    const { post } = setup({ softwareMapEnabled: () => enabled });
    expect(await post({ name: "authoringCapabilities", args: {} })).toEqual({
      ok: true,
      result: { softwareMapEnabled: false },
    });
    enabled = true;
    expect(await post({ name: "authoringCapabilities", args: {} })).toEqual({
      ok: true,
      result: { softwareMapEnabled: true },
    });
  });

  it("routes in-panel views through surface events", async () => {
    const { post, emitted, deps } = setup();
    expect(await post({ name: "showReviewView", args: { view: "commits" } })).toEqual({ ok: true });
    expect(await post({ name: "openDiff", args: { path: "src/a.ts" } })).toEqual({ ok: true });
    expect(emitted).toEqual([
      { event: "showReviewView", view: "commits" },
      { event: "showReviewView", view: "diff" },
    ]);
    expect(deps.revealDiffFile).toHaveBeenCalledWith("src/a.ts");
  });

  it("opens a live worktree file in bb's file preview", async () => {
    const { post, navigate, request } = setup(
      {},
      { "/reviews-api/session-1/file?": { localPath: "/repo/src/a.ts" } },
    );
    expect(
      await post({ name: "reveal", args: { path: "src/a.ts", startLine: 3, endLine: 9 } }),
    ).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith("/reviews-api/session-1/file?file=src%2Fa.ts&side=head");
    expect(navigate.experimental_openFilePreview).toHaveBeenCalledWith({
      target: { kind: "host", hostId: "host-1", path: "/repo/src/a.ts" },
      location: { kind: "range", startLine: 3, endLine: 9 },
    });
  });

  it("explains that a pinned source cannot open", async () => {
    const { post, navigate, deps, request } = setup();
    expect(
      await post({
        name: "reveal",
        args: {
          path: "src/a.ts",
          startLine: 1,
          endLine: 2,
          pins: { repositoryId: "repo-1", head: "abc" },
        },
      }),
    ).toEqual({ ok: false, error: PINNED_SOURCE_NOT_OPENABLE });
    expect(request).not.toHaveBeenCalled();
    expect(navigate.experimental_openFilePreview).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith({ kind: "error", text: PINNED_SOURCE_NOT_OPENABLE });
  });

  it("opens a session in the thread panel with its catalog title", async () => {
    const { post, navigate } = setup(
      {},
      { "/reviews-api?mode=textual": [{ reviewId: "s2", title: "Auth walkthrough" }] },
    );
    expect(await post({ name: "openReview", args: { reviewUuid: "s2", active: true } })).toEqual({
      ok: true,
    });
    expect(navigate.openThreadPanel).toHaveBeenCalledWith({
      actionId: "whiteboard",
      title: "Auth walkthrough",
      params: { sessionId: "s2" },
    });
  });

  it("refuses a session the catalog does not list, as upstream does", async () => {
    const { post, navigate } = setup(
      {},
      { "/reviews-api?mode=textual": [{ reviewId: "s2", title: "Auth walkthrough" }] },
    );
    expect(await post({ name: "openReview", args: { reviewUuid: "gone", active: true } })).toEqual({
      ok: false,
      error: SESSION_NOT_FOUND,
    });
    expect(navigate.openThreadPanel).not.toHaveBeenCalled();
  });

  it("opens a session in the Home route without a thread", async () => {
    const { post, navigate } = setup({ threadId: undefined });
    expect(await post({ name: "openApiReview", args: { reviewId: "s3", title: "T" } })).toEqual({
      ok: true,
      result: { softwareMapEnabled: true },
    });
    expect(navigate.toPluginPanel).toHaveBeenCalledWith("whiteboard", { subPath: "s3" });
    expect(navigate.openThreadPanel).not.toHaveBeenCalled();
  });

  it("answers unavailable verbs without navigating", async () => {
    const { post, navigate, deps } = setup();
    expect(await post({ name: "openSourceTree", args: {} })).toEqual({
      ok: false,
      error: SOURCE_TREE_UNAVAILABLE,
    });
    expect(deps.notify).toHaveBeenCalledWith({ kind: "error", text: SOURCE_TREE_UNAVAILABLE });
    expect(await post({ name: "captureScreenshot", args: {} })).toEqual({
      ok: false,
      error: UNAVAILABLE_IN_BB,
    });
    expect(navigate.toPluginPanel).not.toHaveBeenCalled();
  });

  it("opens the Discord link through bb", async () => {
    const { post, navigate } = setup();
    expect(await post({ name: "joinDiscord", args: {} })).toEqual({
      ok: true,
    });
    expect(navigate.openUrl).toHaveBeenCalledWith(REVIEW_DISCORD_URL);
  });
});

describe("createSurfaceEvents", () => {
  it("keeps delivering when one listener throws, and stops after dispose", () => {
    const events = createSurfaceEvents();
    const seen: unknown[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    events.subscribe(() => {
      throw new Error("boom");
    });
    const subscription = events.subscribe((event) => seen.push(event));
    events.emit({ event: "showReviewView", view: "diff" });
    subscription.dispose();
    events.emit({ event: "showReviewView", view: "commits" });
    expect(seen).toEqual([{ event: "showReviewView", view: "diff" }]);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
