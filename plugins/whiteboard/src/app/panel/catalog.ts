import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { skipToken } from "@tanstack/react-query";
import type { ReviewApiSummary } from "../../shared/vendor/review-protocol/src/index.ts";

export type CatalogAction = "dismiss" | "restore" | "delete";

/**
 * How long a successful dismiss or restore keeps overriding catalog snapshots
 * that disagree with it. A catalog read already in flight when the command
 * landed still carries the old state, so it must not undo the click. Past
 * this limit, a conflicting change from another device shows. A delete has
 * no limit: nothing brings a deleted row back, so a snapshot that still
 * lists it is stale.
 */
export const SETTLE_LIMIT_MS = 15_000;

type Edit = {
  reviewId: string;
  action: CatalogAction;
  at: string;
  /** Its POST succeeded. A row's edits stay until a snapshot agrees with them. */
  settled: boolean;
  /** A settled dismiss or restore no snapshot agreed with in time. */
  expired: boolean;
};

function applyEdits(rows: readonly ReviewApiSummary[], edits: readonly Edit[]) {
  const latest = new Map(edits.map((edit) => [edit.reviewId, edit]));
  return rows.flatMap((review) => {
    const edit = latest.get(review.reviewId);
    if (!edit) return [review];
    if (edit.action === "delete") return [];
    return [{ ...review, dismissedAt: edit.action === "dismiss" ? edit.at : null }];
  });
}

/** Does this snapshot already show what the edit shows? */
function agrees(rows: readonly ReviewApiSummary[], edit: Edit) {
  const row = rows.find((review) => review.reviewId === edit.reviewId);
  // A row deleted elsewhere leaves a dismiss or restore nothing to show.
  if (!row) return true;
  if (edit.action === "delete") return false;
  return Boolean(row.dismissedAt) === (edit.action === "dismiss");
}

const catalogs = new WeakMap<object, ReturnType<typeof newCatalogEdits>>();

/** Share pending edits across Home mounts for the lifetime of their cached query. */
export function createCatalogEdits(queryKey: readonly unknown[]) {
  const query = pluginQueryClient
    .getQueryCache()
    .build(pluginQueryClient, { queryKey, queryFn: skipToken });
  let catalog = catalogs.get(query);
  if (!catalog) {
    catalog = newCatalogEdits(queryKey);
    catalogs.set(query, catalog);
  }
  return catalog;
}

/**
 * Owns live rows and the edits clicks made, so a snapshot cannot undo a
 * click. A row shows its latest edit. Its edits leave together once none is
 * pending and a snapshot agrees with the latest, or that edit expires.
 */
function newCatalogEdits(queryKey: readonly unknown[]) {
  let server = pluginQueryClient.getQueryData<readonly ReviewApiSummary[]>(queryKey) ?? [];
  let edits: Edit[] = [];
  const writes = new Map<string, Promise<void>>();
  const reconcile = () => {
    const done = new Set<string>();
    for (const reviewId of new Set(edits.map((edit) => edit.reviewId))) {
      const row = edits.filter((edit) => edit.reviewId === reviewId);
      const latest = row.at(-1)!;
      if (row.every((edit) => edit.settled) && (latest.expired || agrees(server, latest)))
        done.add(reviewId);
    }
    if (done.size) edits = edits.filter((edit) => !done.has(edit.reviewId));
    pluginQueryClient.setQueryData(queryKey, applyEdits(server, edits));
  };
  return {
    receive(next: readonly ReviewApiSummary[]) {
      server = next;
      reconcile();
    },
    /**
     * Show the edit now and POST it after the row's earlier commands. A
     * failure rolls the row back and rejects, unless a later command for the
     * row supersedes it: that command decides the row, so this resolves.
     */
    async command(reviewId: string, action: CatalogAction, post: () => Promise<unknown>) {
      const edit: Edit = {
        reviewId,
        action,
        at: new Date().toISOString(),
        settled: false,
        expired: false,
      };
      edits.push(edit);
      reconcile();
      const previous = writes.get(reviewId);
      const write = (async () => {
        await previous;
        try {
          await post();
        } catch (error) {
          const later = edits.slice(edits.indexOf(edit) + 1);
          const superseded = later.some((entry) => entry.reviewId === reviewId);
          edits = edits.filter((entry) => entry !== edit);
          reconcile();
          if (superseded) return;
          throw error;
        }
        edit.settled = true;
        if (action !== "delete")
          setTimeout(() => {
            if (!edits.includes(edit)) return;
            edit.expired = true;
            reconcile();
          }, SETTLE_LIMIT_MS);
        reconcile();
      })();
      const tail = write.catch(() => {});
      writes.set(reviewId, tail);
      try {
        await write;
      } finally {
        if (writes.get(reviewId) === tail) writes.delete(reviewId);
      }
    },
  };
}
