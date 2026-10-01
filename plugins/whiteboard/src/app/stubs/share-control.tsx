import { createContext } from "react";
import type { ReviewApiClient } from "../../shared/vendor/review-protocol/src/index.ts";

/**
 * Replaces upstream `share-control.tsx` (design §2.3 D). Sharing needs the
 * dev.fast cloud, so the topbar control renders nothing. `SharingContext`
 * keeps upstream's type and default (`null`), because `api-canvas.tsx` still
 * provides it.
 */
export const SharingContext = createContext<{
  client: ReviewApiClient;
  reviewId: string;
  version: number;
  sender?: string;
  cloneUrl?: string;
} | null>(null);

export function ShareControl(): null {
  return null;
}
