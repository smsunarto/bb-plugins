import type { LocalReviewData } from "../vendor/review/src/review-api/local-data.ts";
import type { ReviewStore } from "../vendor/review/src/review-api/store.ts";

/**
 * Sharing is out of scope (design §2.3 E). `createReviewApi` receives no
 * `SharedReviewStore`, so `SharedReviewData` is never constructed and
 * `mountSharingHost` never runs. The types cover what `http.ts` touches.
 */
export interface SharingHostEvents {
  onPublished?: (event: { reviewId: string; version: number }) => void;
  onRevoked?: (event: { shareId: string }) => void;
  onLogin?: (
    outcome: "started" | "succeeded" | "failed",
    reason?: "did_not_finish" | "error",
  ) => void;
}

export interface SharedReviewStore {
  connect(store: ReviewStore, data: LocalReviewData): void;
  get(id: string): any;
  list(mode?: "structural" | "textual"): any[];
  subscribe(listener: () => void): () => void;
  assertReady(id: string): Promise<void>;
  removeLocal(id: string): Promise<void>;
  setAttention(id: string, action: "view" | "dismiss" | "restore"): Promise<void>;
}

export class SharedReviewData {
  constructor(_store: SharedReviewStore) {
    throw new Error("whiteboard: sharing is not available in bb");
  }

  map(_id: string, _resourceId: string): any {
    return undefined;
  }

  async resource(..._args: unknown[]): Promise<any> {
    return undefined;
  }
}

export function mountSharingHost(..._args: unknown[]): void {}
