import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewRequest } from "../../shared/schema.ts";
import { liveSubthread } from "./subthreads.ts";
import type { LocatedRepository } from "./subthreads.ts";

/**
 * Which branch each Create PR subthread is for. bb threads carry no metadata,
 * so the panel keeps that map itself, per parent thread, in plugin KV. It
 * outlives the panel: closing it, switching repositories, or cancelling a Land
 * still finds the running subthread instead of starting a second one. An
 * entry is for the repository's place on its host, as the conflict
 * subthread's is: a thread that moved to another environment has other
 * branches, even under the same names.
 */

type Entry = { hostId: string; path: string; branch: string; threadId: string };

const kvKey = (threadId: string) => `review-requests:${threadId}`;

const inRepository = (entry: Partial<Entry>, { hostId, path }: LocatedRepository) =>
  entry.hostId === hostId && entry.path === path;

/** The subthreads still around for one repository. Archived or deleted ones drop out. */
export async function readReviewRequests(
  bb: BbPluginApi,
  threadId: string,
  repository: LocatedRepository,
): Promise<ReviewRequest[]> {
  const entries = (await bb.storage.kv.get<Entry[]>(kvKey(threadId))) ?? [];
  const requests = await Promise.all(
    entries
      .filter((entry) => inRepository(entry, repository))
      .map(async ({ branch, threadId: childId }) => {
        const child = await liveSubthread(bb, childId);
        return child ? { branch, threadId: childId, running: child.running } : null;
      }),
  );
  return requests.filter((request) => request !== null);
}

/** A branch has one subthread at a time, so a new one replaces the old entry. */
export async function recordReviewRequest(
  bb: BbPluginApi,
  threadId: string,
  repository: LocatedRepository,
  { branch, threadId: childId }: { branch: string; threadId: string },
) {
  const entries = (await bb.storage.kv.get<Entry[]>(kvKey(threadId))) ?? [];
  const others = entries.filter(
    (other) => !inRepository(other, repository) || other.branch !== branch,
  );
  const entry: Entry = {
    hostId: repository.hostId,
    path: repository.path,
    branch,
    threadId: childId,
  };
  await bb.storage.kv.set(kvKey(threadId), [...others, entry]);
}
