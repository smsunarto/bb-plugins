import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Threads = Pick<BbPluginApi["sdk"]["threads"], "get" | "update">;

/** Deeper than any real family; stops a corrupt parent chain from looping. */
const ANCESTOR_LIMIT = 64;

export type NestThreadResult =
  | { ok: true }
  | {
      ok: false;
      reason: "self" | "same-parent" | "cross-project" | "cycle" | "not-found" | "update-failed";
    };

export interface ThreadNester {
  /** Re-parents `threadId` under `parentThreadId`, or to the top level for null. */
  nest(threadId: string, parentThreadId: string | null): Promise<NestThreadResult>;
}

/**
 * bb's `threads.update({ parentThreadId })` behind the checks the sidebar's
 * drop needs and bb itself may not make: no self-parenting, no parent from
 * another project (the sidebar draws a family under its parent's project
 * group, so a cross-project child would sit under the wrong header), and no
 * parent from inside the moved family (a cycle, which the tree would drop).
 */
export function createThreadNester(threads: Threads): ThreadNester {
  return {
    async nest(threadId, parentThreadId) {
      if (threadId === parentThreadId) return { ok: false, reason: "self" };
      let source;
      try {
        source = await threads.get({ threadId });
      } catch {
        return { ok: false, reason: "not-found" };
      }
      if (source.parentThreadId === parentThreadId) return { ok: false, reason: "same-parent" };
      if (parentThreadId !== null) {
        let cursor: string | null = parentThreadId;
        for (let hop = 0; cursor !== null && hop < ANCESTOR_LIMIT; hop++) {
          let ancestor;
          try {
            ancestor = await threads.get({ threadId: cursor });
          } catch {
            return { ok: false, reason: "not-found" };
          }
          if (hop === 0 && ancestor.projectId !== source.projectId) {
            return { ok: false, reason: "cross-project" };
          }
          if (ancestor.id === threadId) return { ok: false, reason: "cycle" };
          cursor = ancestor.parentThreadId;
        }
      }
      try {
        await threads.update({ threadId, parentThreadId });
      } catch {
        return { ok: false, reason: "update-failed" };
      }
      return { ok: true };
    },
  };
}
