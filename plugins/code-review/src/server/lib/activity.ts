import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  AGENT_ACTIVITY_CHANNEL,
  type AgentActivity,
  type DiffRevision,
  type LinkedThread,
  type PrRef,
  prKey,
  sameRevision,
} from "../../shared/schema.ts";
import type { Link, Store } from "./store.ts";

/*
 * The bb threads started for a pull request: Codex reviews and check fixes.
 * Their status is read live from bb, so a thread the reader stopped,
 * archived, or deleted shows as it is now.
 */

const RUNNING = new Set<LinkedThread["status"]>(["pending", "starting", "active", "stopping"]);

/** The SDK's `BbHttpError` carries the HTTP status. The plugin SDK does not export the class. */
function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

async function linkedThread(bb: BbPluginApi, link: Link): Promise<LinkedThread> {
  const thread = await bb.sdk.threads.get({ threadId: link.threadId }).catch((error: unknown) => {
    if (isNotFound(error)) return null;
    throw error;
  });
  const gone = !thread || thread.deletedAt !== null;
  return {
    threadId: link.threadId,
    kind: link.kind,
    title: gone ? null : (thread.title ?? thread.titleFallback),
    status: gone ? "missing" : thread.status,
    createdAt: link.createdAt,
    headRefOid: link.headRefOid,
    baseRefName: link.baseRefName,
  };
}

/**
 * Linked threads, newest first, and the review to show. That is the newest
 * review that reported, unless a newer one is still at work: then it is
 * that one, with no findings yet, so the reader sees a review is under way.
 */
export async function agentActivity(
  bb: BbPluginApi,
  store: Store,
  ref: PrRef,
): Promise<AgentActivity> {
  const links = await store.links(ref);
  const threads = await Promise.all(links.map((link) => linkedThread(bb, link)));
  for (const thread of threads) {
    if (thread.kind !== "review") continue;
    const run = await store.run(thread.threadId);
    if (run) return { threads, latestReview: run };
    if (RUNNING.has(thread.status)) {
      const pending = {
        threadId: thread.threadId,
        headRefOid: thread.headRefOid,
        baseRefName: thread.baseRefName,
        reportedAt: null,
        summary: null,
        findings: [],
      };
      return { threads, latestReview: pending };
    }
  }
  return { threads, latestReview: null };
}

export function publishActivity(bb: BbPluginApi, key: string): void {
  bb.realtime.publish(AGENT_ACTIVITY_CHANNEL, { key });
}

/** Records a thread started for `ref` and tells open panels. */
export async function linkThread(
  bb: BbPluginApi,
  store: Store,
  ref: PrRef,
  link: Omit<Link, "createdAt">,
): Promise<void> {
  await store.addLink(ref, { ...link, createdAt: new Date().toISOString() });
  publishActivity(bb, prKey(ref));
}

/** The running review of `revision`, if one was already started. */
export async function runningReview(
  bb: BbPluginApi,
  store: Store,
  ref: PrRef,
  revision: DiffRevision,
): Promise<string | null> {
  const link = (await store.links(ref)).find(
    (l) => l.kind === "review" && sameRevision(l, revision),
  );
  if (!link || (await store.run(link.threadId))) return null;
  const thread = await linkedThread(bb, link);
  return RUNNING.has(thread.status) ? thread.threadId : null;
}
