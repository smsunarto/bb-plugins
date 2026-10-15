import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewRequest } from "../../shared/schema.ts";
import { liveSubthread } from "./subthreads.ts";
import type { LocatedRepository } from "./subthreads.ts";
import { writeTarget } from "./target.ts";

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

/** Each parent's requests share one KV array, including its other repositories. */
const claims = new WeakMap<BbPluginApi, Map<string, Promise<string>>>();

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

/**
 * Claims one PR subthread, with the lookup, spawn, and record kept together.
 * Requests for different branches also take turns: their records share the
 * parent's KV array. A failed claim frees the next request to retry.
 */
export function claimReviewRequest(
  bb: BbPluginApi,
  threadId: string,
  repository: LocatedRepository,
  branch: string,
  start: () => Promise<string>,
): Promise<string> {
  let parentClaims = claims.get(bb);
  if (!parentClaims) {
    parentClaims = new Map();
    claims.set(bb, parentClaims);
  }
  const queue = parentClaims;
  const claim = (queue.get(threadId) ?? Promise.resolve(""))
    .catch(() => "")
    .then(async () => {
      // The parent may have moved while this request waited behind another.
      await writeTarget(bb, threadId, repository.environmentId);
      const running = (await readReviewRequests(bb, threadId, repository)).find(
        (request) => request.branch === branch && request.running,
      );
      if (running) return running.threadId;
      const childId = await start();
      await recordReviewRequest(bb, threadId, repository, { branch, threadId: childId });
      return childId;
    });
  queue.set(threadId, claim);
  const release = () => {
    if (queue.get(threadId) !== claim) return;
    queue.delete(threadId);
    if (queue.size === 0) claims.delete(bb);
  };
  claim.then(release, release);
  return claim;
}

/** A branch has one subthread at a time, so a new one replaces the old entry. */
async function recordReviewRequest(
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
