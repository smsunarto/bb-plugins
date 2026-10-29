import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  AGENT_ACTIVITY_CHANNEL,
  type AgentActivity,
  type DiffRevision,
  type LinkedThread,
  sameRevision,
} from "../../shared/schema.ts";
import type { Link, Store } from "./store.ts";

/*
 * The bb threads started for a subject (a pull request, or an unpublished
 * branch): bb reviews and check fixes.
 * Their status is read live from bb, so a thread the reader stopped,
 * archived, or deleted shows as it is now.
 */

const RUNNING = new Set<LinkedThread["status"]>(["pending", "starting", "active", "stopping"]);

/** The SDK's `BbHttpError` carries the HTTP status. The plugin SDK does not export the class. */
export function isNotFound(error: unknown): boolean {
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
 * Linked threads, newest first, and the review to show: the newest that
 * reported. A review still under way is one of the threads, with no run yet.
 */
export async function agentActivity(
  bb: BbPluginApi,
  store: Store,
  subject: string,
): Promise<AgentActivity> {
  const links = await store.links(subject);
  const threads = await Promise.all(links.map((link) => linkedThread(bb, link)));
  for (const thread of threads) {
    if (thread.kind !== "review") continue;
    const run = await store.run(thread.threadId);
    if (run) return { threads, latestReview: run };
  }
  return { threads, latestReview: null };
}

export function publishActivity(bb: BbPluginApi, key: string): void {
  bb.realtime.publish(AGENT_ACTIVITY_CHANNEL, { key });
}

/** Records a thread started for `subject` and tells open panels. */
export async function linkThread(
  bb: BbPluginApi,
  store: Store,
  subject: string,
  link: Omit<Link, "createdAt">,
): Promise<void> {
  await store.addLink(subject, { ...link, createdAt: new Date().toISOString() });
  publishActivity(bb, subject);
}

/** The running review of `revision`, if one was already started. */
export async function runningReview(
  bb: BbPluginApi,
  store: Store,
  subject: string,
  revision: DiffRevision,
): Promise<string | null> {
  const link = (await store.links(subject)).find(
    (l) => l.kind === "review" && sameRevision(l, revision),
  );
  if (!link || (await store.run(link.threadId))) return null;
  const thread = await linkedThread(bb, link);
  return RUNNING.has(thread.status) ? thread.threadId : null;
}
