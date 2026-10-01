import type { BbNavigate } from "@get-bb/plugin-sdk/app";
import type { WhiteboardRpcClient } from "../rpc.ts";
import type { OpenSourceFile } from "./diff-view.tsx";
import {
  REVIEW_DISCORD_URL,
  type ReviewSourceView,
  type ReviewVerbRequest,
  type ReviewVerbResponse,
} from "../../shared/vendor/review-protocol/src/index.ts";
import { NAV_PANEL_PATH, PANEL_ACTION_ID } from "../../shared/contracts/panel.ts";
import type { SurfaceEvents } from "./events.ts";
import type { ApiRequestFn } from "./tunnel.ts";

/**
 * `ReviewCanvasBridge.post` mapped onto bb navigation and panels (design §3.8).
 *
 *   reveal          live worktree file -> bb file preview; pinned source -> toast
 *   openDiff        Diffs view + revealFile
 *   openReview      thread: openThreadPanel({sessionId}); Home: toPluginPanel(subPath)
 *   showReviewView  in-panel route (surface event)
 *   openSourceTree  unavailable in bb
 */
export const SOURCE_TREE_UNAVAILABLE = "Source tree is unavailable in bb.";
export const UNAVAILABLE_IN_BB = "Unavailable in bb.";
export const PINNED_SOURCE_NOT_OPENABLE =
  "This source is pinned to a commit. bb can open only live worktree files.";
export const BASE_SOURCE_NOT_OPENABLE = "Base source is read only.";

export type VerbDeps = {
  navigate: BbNavigate;
  /** The panel's thread; absent on the Home navPanel. */
  threadId?: string;
  reviewId?: string;
  request: ApiRequestFn;
  events: SurfaceEvents;
  notify(message: { kind: "success" | "error"; text: string }): void;
  /** Scroll the Diffs view to a file once it is mounted. */
  revealDiffFile(path: string): void;
  openFile: OpenSourceFile;
  sourceView?: () => ReviewSourceView | undefined;
  softwareMapEnabled(): boolean;
};

const ok = (result?: unknown): ReviewVerbResponse =>
  result === undefined ? { ok: true } : { ok: true, result };

const fail = (error: string): ReviewVerbResponse => ({ ok: false, error });

async function readJson(request: ApiRequestFn, path: string): Promise<unknown> {
  const response = await request(path);
  if (!response.ok) throw new Error(`Review request failed (${response.status}).`);
  return response.json();
}

/** Upstream's wording when `openReview` names a session the catalog lacks (reviewVerbs.ts). */
export const SESSION_NOT_FOUND = "Session not found.";

/**
 * The catalog entry's title. `null` when the catalog has no such session,
 * `undefined` when the catalog could not be read (open without a title).
 */
async function sessionTitle(
  request: ApiRequestFn,
  reviewId: string,
): Promise<string | null | undefined> {
  let catalog: unknown;
  try {
    catalog = await readJson(request, "/reviews-api?mode=textual");
  } catch {
    return undefined;
  }
  if (!Array.isArray(catalog)) return undefined;
  const entry: unknown = catalog.find(
    (item: unknown) =>
      typeof item === "object" && item !== null && "reviewId" in item && item.reviewId === reviewId,
  );
  if (entry === undefined) return null;
  return typeof entry === "object" &&
    entry !== null &&
    "title" in entry &&
    typeof entry.title === "string"
    ? entry.title
    : undefined;
}

function openSession(deps: VerbDeps, sessionId: string, title: string | undefined): boolean {
  if (deps.threadId) {
    return deps.navigate.openThreadPanel({
      actionId: PANEL_ACTION_ID,
      ...(title ? { title } : {}),
      params: { sessionId },
    });
  }
  deps.navigate.toPluginPanel(NAV_PANEL_PATH, { subPath: sessionId });
  return true;
}

/** The server owns repository/host routing and whether a pinned source has a live copy. */
export function createLiveFileOpener(deps: {
  rpc: WhiteboardRpcClient;
  navigate: BbNavigate;
  notify(message: { kind: "success" | "error"; text: string }): void;
}): OpenSourceFile {
  return async (input) => {
    const { target } = await deps.rpc.liveFile({
      sessionId: input.reviewId,
      ...(input.version === undefined ? {} : { version: input.version }),
      ...(input.generation === undefined ? {} : { generation: input.generation }),
      path: input.path,
      ...input.pins,
    });
    if (!target) {
      deps.notify({ kind: "error", text: PINNED_SOURCE_NOT_OPENABLE });
      return false;
    }
    return deps.navigate.experimental_openFilePreview({
      target,
      location:
        input.startLine === undefined
          ? null
          : {
              kind: "range",
              startLine: input.startLine,
              endLine: input.endLine ?? input.startLine,
            },
    });
  };
}

async function reveal(
  deps: VerbDeps,
  args: Extract<ReviewVerbRequest, { name: "reveal" }>["args"],
): Promise<ReviewVerbResponse> {
  // Base line numbers belong to the historical file, never the live head.
  if (args.side === "base") {
    deps.notify({ kind: "error", text: BASE_SOURCE_NOT_OPENABLE });
    return fail(BASE_SOURCE_NOT_OPENABLE);
  }
  if (!deps.reviewId) return fail(PINNED_SOURCE_NOT_OPENABLE);
  try {
    const view = deps.sourceView?.();
    const opened = await deps.openFile({
      reviewId: view?.reviewId ?? deps.reviewId,
      ...(view
        ? { version: view.version, generation: args.pins ? undefined : view.generation }
        : {}),
      path: args.path,
      pins: args.pins,
      startLine: args.startLine,
      endLine: args.endLine,
    });
    return opened ? ok() : fail(PINNED_SOURCE_NOT_OPENABLE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.notify({ kind: "error", text: message });
    return fail(message);
  }
}

export function createVerbs(
  deps: VerbDeps,
): (request: ReviewVerbRequest) => Promise<ReviewVerbResponse> {
  return async (request) => {
    switch (request.name) {
      case "authoringCapabilities":
        return ok({ softwareMapEnabled: deps.softwareMapEnabled() });
      case "showReviewView":
        deps.events.emit({ event: "showReviewView", view: request.args.view });
        return ok();
      case "openDiff":
        deps.events.emit({ event: "showReviewView", view: "diff" });
        deps.revealDiffFile(request.args.path);
        return ok();
      case "reveal":
        return reveal(deps, request.args);
      case "openReview": {
        const title = await sessionTitle(deps.request, request.args.reviewUuid);
        if (title === null) return fail(SESSION_NOT_FOUND);
        return openSession(deps, request.args.reviewUuid, title) ? ok() : fail(UNAVAILABLE_IN_BB);
      }
      case "openApiReview":
        return openSession(deps, request.args.reviewId, request.args.title)
          ? ok({ softwareMapEnabled: deps.softwareMapEnabled() })
          : fail(UNAVAILABLE_IN_BB);
      case "openSourceTree":
        deps.notify({ kind: "error", text: SOURCE_TREE_UNAVAILABLE });
        return fail(SOURCE_TREE_UNAVAILABLE);
      case "joinDiscord":
        return deps.navigate.openUrl(REVIEW_DISCORD_URL) ? ok() : fail(UNAVAILABLE_IN_BB);
      case "focusCanvas":
      case "focusWindow":
      case "openReviewRevision":
        // api-canvas consumes openReviewRevision before the bridge sees it.
        return ok();
      case "captureScreenshot":
        return fail(UNAVAILABLE_IN_BB);
    }
  };
}
