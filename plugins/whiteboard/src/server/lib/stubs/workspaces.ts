import {
  type Pins,
  ReviewInputError,
} from "../../../shared/vendor/review/src/review-api/document.ts";
import type { ReviewStore } from "../vendor/review/src/review-api/store.ts";

/** Upstream `WorkspaceStatus` (review-api/workspaces.ts:23-38). */
export interface WorkspaceStatus {
  id: string;
  commit: string;
  rootPath: string | null;
  generation: string;
  state: "pending" | "preparing" | "ready" | "unconfigured" | "failed" | "cleanup-failed";
  log: string;
  issue?: string;
}

/**
 * Upstream `ReviewWorkspaces` with "nothing configured" results (design §3.10).
 * Managed language checkouts feed Desktop LSP only, so bb prepares none: no
 * `node:sqlite`, no checkouts, no installs. Agents see `{issues: []}` from
 * `session_environment` and `{failures: []}` from `session_workspace_cleanup`,
 * as Desktop shows for a repository with no prepare configuration. No
 * environment is ever listed, so a retry by ID gets upstream's 404 text.
 */
export class ReviewWorkspaces {
  // oxlint-disable-next-line no-useless-constructor -- keeps upstream's constructor arity for `local-data.ts`
  constructor(_databasePath: string, _store: ReviewStore) {}

  attachExternalReviews(_source: {
    has(id: string): boolean;
    subscribe(listener: () => void): () => void;
  }): void {}

  async remove(_reviewId: string): Promise<void> {}

  list(_reviewId: string): WorkspaceStatus[] {
    return [];
  }

  failures(): WorkspaceStatus[] {
    return [];
  }

  async retryCleanup(_id: string): Promise<void> {
    throw new ReviewInputError("Cleanup failure not found.", 404);
  }

  async open(_reviewId: string, _pins: Pins): Promise<void> {}

  async source(
    reviewId: string,
    pins: Pins,
    side: "base" | "head",
    _retryFailed = false,
  ): Promise<WorkspaceStatus> {
    return unconfigured(`${reviewId}:${side}`, pins[side]);
  }

  async retry(_reviewId: string, _id: string): Promise<WorkspaceStatus> {
    throw new ReviewInputError("Language environment not found.", 404);
  }

  async idle(): Promise<void> {}

  async close(): Promise<void> {}
}

function unconfigured(id: string, commit: string): WorkspaceStatus {
  return { id, commit, rootPath: null, generation: "", state: "unconfigured", log: "" };
}
