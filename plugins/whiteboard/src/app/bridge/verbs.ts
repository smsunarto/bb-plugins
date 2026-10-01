import type { BbNavigate } from "@get-bb/plugin-sdk/app";
import {
  REVIEW_DISCORD_URL,
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
  /** The bb host that holds this session's checkout, when known. */
  resolveHostId(): Promise<string | undefined>;
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

async function reveal(
  deps: VerbDeps,
  args: Extract<ReviewVerbRequest, { name: "reveal" }>["args"],
): Promise<ReviewVerbResponse> {
  const side = args.side ?? "head";
  // `/:id/file` answers `localPath` only for an unpinned head read of a
  // worktree target whose live file still matches (local-data.ts liveFile).
  let localPath: string | undefined;
  if (deps.reviewId && !args.pins && side === "head") {
    try {
      const file = await readJson(
        deps.request,
        `/reviews-api/${encodeURIComponent(deps.reviewId)}/file?${new URLSearchParams({ file: args.path, side })}`,
      );
      if (
        typeof file === "object" &&
        file !== null &&
        "localPath" in file &&
        typeof file.localPath === "string"
      )
        localPath = file.localPath;
    } catch {
      localPath = undefined;
    }
  }
  const hostId = localPath ? await deps.resolveHostId() : undefined;
  if (!localPath || !hostId) {
    deps.notify({ kind: "error", text: PINNED_SOURCE_NOT_OPENABLE });
    return fail(PINNED_SOURCE_NOT_OPENABLE);
  }
  const opened = deps.navigate.experimental_openFilePreview({
    target: { kind: "host", hostId, path: localPath },
    location: { kind: "range", startLine: args.startLine, endLine: args.endLine },
  });
  return opened ? ok() : fail(UNAVAILABLE_IN_BB);
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
