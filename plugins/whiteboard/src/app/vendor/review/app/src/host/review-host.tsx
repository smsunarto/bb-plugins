// Vendored from dev.fast review/app/src/host/review-host.tsx @4ecc570 (MIT).
import type {
  ReviewCanvasBridge,
  ReviewDiffFileWire,
  ReviewDiffSide,
  ReviewRangeWire,
  ReviewSourcePins,
  ReviewSurfaceEvent,
  ReviewVerbRequest,
} from "../../../../../../shared/vendor/review-protocol/src/index.ts";

export interface ReviewSurface {
  openFileDiff(file: ReviewDiffFileWire): void;
  /** `pins` opens the file at a reference's own pins instead of the review's. */
  revealAnchor(
    path: string,
    range: ReviewRangeWire,
    side?: ReviewDiffSide,
    pins?: ReviewSourcePins,
  ): void;
  post(request: ReviewVerbRequest): Promise<void>;
  subscribe(listener: (event: ReviewSurfaceEvent) => void): () => void;
}

export function createReviewSurface(bridge: ReviewCanvasBridge): ReviewSurface {
  return {
    openFileDiff(file) {
      void bridge.post({
        name: "openDiff",
        args: { path: file.path, previousPath: file.previousPath },
      });
    },
    revealAnchor(path, range, side, pins) {
      void bridge.post({
        name: "reveal",
        args: {
          path,
          startLine: range.fromLine,
          endLine: range.toLine,
          side,
          pins,
          highlight: true,
          preserveFocus: false,
        },
      });
    },
    async post(request) {
      const response = await bridge.post(request);

      if (!response.ok) throw new Error(response.error);
    },
    subscribe(listener) {
      const subscription = bridge.subscribe(listener);

      return () => subscription.dispose();
    },
  };
}
