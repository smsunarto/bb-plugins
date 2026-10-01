import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { gitbutlerHostContract } from "../../shared/host-contract.ts";
import type { ReviewRequest } from "../../shared/schema.ts";
import { resolveTarget } from "./target.ts";

/**
 * Which branch each Create PR subthread is for. bb threads carry no metadata,
 * so the panel keeps that map itself, per parent thread, in plugin KV. It
 * outlives the panel: closing it, switching repositories, or cancelling a Land
 * still finds the running subthread instead of starting a second one.
 */

type Entry = { repositoryKey: string; branch: string; threadId: string };

const RUNNING = new Set(["pending", "starting", "active", "stopping"]);

const kvKey = (threadId: string) => `review-requests:${threadId}`;

/**
 * The repository the panel means, resolved by the host the same way every
 * other call is. An omitted key is the panel's default repository, so the
 * subthread gets that repository's path rather than no path at all.
 */
export async function locateRepository(
  bb: BbPluginApi,
  threadId: string,
  repositoryKey: string | undefined,
) {
  const { target, reason } = await resolveTarget(bb, threadId);
  if (!target) throw new Error(reason);
  return bb.hosts
    .experimental_client({ contract: gitbutlerHostContract })
    .call(
      "repository",
      { environmentPath: target.environmentPath, ...(repositoryKey ? { repositoryKey } : {}) },
      { hostId: target.hostId },
    );
}

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
        const child = await bb.sdk.threads.get({ threadId: childId }).catch(() => null);
        if (!child || child.archivedAt !== null || child.deletedAt !== null) return null;
        return { branch, threadId: childId, running: RUNNING.has(child.status) };
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
