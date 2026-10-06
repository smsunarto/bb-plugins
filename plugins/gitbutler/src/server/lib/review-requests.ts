import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewRequest } from "../../shared/schema.ts";
import { liveSubthread } from "./subthreads.ts";

/**
 * Which branch each Create PR subthread is for. bb threads carry no metadata,
 * so the panel keeps that map itself, per parent thread, in plugin KV. It
 * outlives the panel: closing it, switching repositories, or cancelling a Land
 * still finds the running subthread instead of starting a second one.
 */

type Entry = { repositoryKey: string; branch: string; threadId: string };

const kvKey = (threadId: string) => `review-requests:${threadId}`;

/** The subthreads still around for one repository. Archived or deleted ones drop out. */
export async function readReviewRequests(
  bb: BbPluginApi,
  threadId: string,
  repositoryKey: string,
): Promise<ReviewRequest[]> {
  const entries = (await bb.storage.kv.get<Entry[]>(kvKey(threadId))) ?? [];
  const requests = await Promise.all(
    entries
      .filter((entry) => entry.repositoryKey === repositoryKey)
      .map(async ({ branch, threadId: childId }) => {
        const child = await liveSubthread(bb, childId);
        return child ? { branch, threadId: childId, running: child.running } : null;
      }),
  );
  return requests.filter((request) => request !== null);
}

/** A branch has one subthread at a time, so a new one replaces the old entry. */
export async function recordReviewRequest(bb: BbPluginApi, threadId: string, entry: Entry) {
  const entries = (await bb.storage.kv.get<Entry[]>(kvKey(threadId))) ?? [];
  const others = entries.filter(
    (other) => other.repositoryKey !== entry.repositoryKey || other.branch !== entry.branch,
  );
  await bb.storage.kv.set(kvKey(threadId), [...others, entry]);
}
