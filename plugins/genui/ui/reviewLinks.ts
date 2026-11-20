// Whether a link to a pull request in this block opens in Review: Source
// Control is running and this block's thread is in view. Hints say Review
// only then; otherwise, as when the thread is archived or Source Control is
// off, they name the link, which is where a press goes.
import {
  isPullRequestReviewAvailable,
  onPullRequestReviewAvailabilityChange,
} from "@bb-plugins/review-request";
import { useSyncExternalStore } from "react";
import { useUiRuntime } from "./runtime";

/** Source Control's answer per thread, until it reports a change. */
const answers = new Map<string, boolean>();
const listeners = new Set<() => void>();
let listening: AbortController | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listening === null) {
    listening = new AbortController();
    // Answers read before anyone listened may be stale.
    answers.clear();
    onPullRequestReviewAvailabilityChange(() => {
      answers.clear();
      for (const each of listeners) each();
    }, listening.signal);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    listening?.abort();
    listening = null;
  };
}

function available(threadId: string): boolean {
  let answer = answers.get(threadId);
  if (answer === undefined) {
    answer = isPullRequestReviewAvailable(threadId);
    answers.set(threadId, answer);
  }
  return answer;
}

/** Whether this block's pull request links open in Review now. */
export function useReviewLinks(): boolean {
  const { threadId } = useUiRuntime();
  return useSyncExternalStore(subscribe, () => threadId !== null && available(threadId));
}
