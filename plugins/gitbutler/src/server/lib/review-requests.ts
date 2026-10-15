import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewRequest } from "../../shared/schema.ts";
import { liveSubthread, locateRepository } from "./subthreads.ts";
import type { LocatedRepository } from "./subthreads.ts";
import { writeTarget } from "./target.ts";

/**
 * Which branch each Create PR subthread is for. bb threads carry no metadata,
 * so the panel keeps that map itself, per canonical checkout, in plugin KV. It
 * outlives the panel: closing it, switching repositories, or cancelling a Land
 * still finds the running subthread instead of starting a second one. An
 * entry is for the repository's place on its host, as the conflict
 * subthread's is: a thread that moved to another environment has other
 * branches, even under the same names.
 */

type Entry = { hostId: string; path: string; branch: string; threadId: string };

const kvKey = ({ hostId, path }: LocatedRepository) => `review-requests:${hostId}:${path}`;

/** In-flight requests share a queue per canonical checkout. */
const claims = new WeakMap<BbPluginApi, Map<string, Promise<string>>>();

const inRepository = (entry: Partial<Entry>, { hostId, path }: LocatedRepository) =>
  entry.hostId === hostId && entry.path === path;

/** The subthreads still around for one repository. Archived or deleted ones drop out. */
export async function readReviewRequests(
  bb: BbPluginApi,
  threadId: string,
  repository: LocatedRepository,
): Promise<ReviewRequest[]> {
  // Keep pre-checkout requests visible while storing all new claims by canonical checkout.
  const [current, legacy] = await Promise.all([
    bb.storage.kv.get<Entry[]>(kvKey(repository)),
    bb.storage.kv.get<Entry[]>(`review-requests:${threadId}`),
  ]);
  const entries = [...(current ?? []), ...(legacy ?? [])].filter(
    (entry, index, all) =>
      all.findIndex(
        (other) =>
          other.hostId === entry.hostId &&
          other.path === entry.path &&
          other.branch === entry.branch,
      ) === index,
  );
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
 * Requests for different branches in one checkout also take turns: their
 * records share its KV array. A failed claim frees the next request to retry.
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
  const key = kvKey(repository);
  const claim = (queue.get(key) ?? Promise.resolve(""))
    .catch(() => "")
    .then(async () => {
      // The parent may have moved while this request waited behind another.
      await writeTarget(bb, threadId, repository.environmentId);
      if (repository.checkout || repository.identity?.kind === "git") {
        await locateRepository(
          bb,
          threadId,
          repository.repositoryKey,
          repository.environmentId,
          repository.checkout,
          repository.identity
            ? {
                branch: repository.identity.branch,
                head: repository.identity.head,
                origin: repository.identity.origin,
              }
            : undefined,
        );
      }
      const running = (await readReviewRequests(bb, threadId, repository)).find(
        (request) => request.branch === branch && request.running,
      );
      if (running) return running.threadId;
      const childId = await start();
      await recordReviewRequest(bb, repository, { branch, threadId: childId });
      return childId;
    });
  queue.set(key, claim);
  const release = () => {
    if (queue.get(key) !== claim) return;
    queue.delete(key);
    if (queue.size === 0) claims.delete(bb);
  };
  claim.then(release, release);
  return claim;
}

/** A branch has one subthread at a time, so a new one replaces the old entry. */
async function recordReviewRequest(
  bb: BbPluginApi,
  repository: LocatedRepository,
  { branch, threadId: childId }: { branch: string; threadId: string },
) {
  const entries = (await bb.storage.kv.get<Entry[]>(kvKey(repository))) ?? [];
  const others = entries.filter(
    (other) => !inRepository(other, repository) || other.branch !== branch,
  );
  const entry: Entry = {
    hostId: repository.hostId,
    path: repository.path,
    branch,
    threadId: childId,
  };
  await bb.storage.kv.set(kvKey(repository), [...others, entry]);
}
