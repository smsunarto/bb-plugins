/** How long a request waits for its thread before the caller offers GitHub. */
export const PENDING_MS = 10_000;

export type OpenPullRequest = (href: string) => boolean;

type PendingReview = {
  readonly threadId: string;
  readonly url: string;
  readonly fallback: () => void;
};

let waiting: (PendingReview & { timer: ReturnType<typeof setTimeout> }) | null = null;

export function pendingReviewThread(): string | undefined {
  return waiting?.threadId;
}

/** A newer intent took over, so the older request should neither open nor fall back. */
export function retirePendingReview(): void {
  if (waiting) clearTimeout(waiting.timer);
  waiting = null;
}

export function settlePendingReview(open: OpenPullRequest | null): void {
  const ask = waiting;
  if (!ask) return;
  retirePendingReview();
  if (!open?.(ask.url)) ask.fallback();
}

export function waitForReview(ask: PendingReview): void {
  retirePendingReview();
  waiting = { ...ask, timer: setTimeout(() => settlePendingReview(null), PENDING_MS) };
}
