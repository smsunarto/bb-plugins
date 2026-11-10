/**
 * One Change's review, read through the keyed `reviewForChange` query that
 * the rail, the diff's annotations and the thread tab's card all share, and
 * the writes that change it. Writes predict the shared entry at once, so a
 * checkbox ticked anywhere is ticked everywhere; the server's next read is
 * the truth and replaces the prediction.
 */
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
} from "@get-bb/plugin-sdk/app";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeKey } from "../core/ids.ts";
import type { ChangeReview, Draft, DraftInput } from "../core/items.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { ReviewInterner, type StableReview } from "./review-model.ts";

const NO_KEYS: readonly string[] = [];

export type ReviewRead = {
  /** Undefined until the first read answers. */
  review: ChangeReview | undefined;
  stable: StableReview;
  error: string | null;
  refetch(): void;
};

/** The Change's review; `enabled: false` reads only what is already cached. */
export function useChangeReview(key: ChangeKey | null, enabled = true): ReviewRead {
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "reviewForChange",
    keys: key ? [key] : NO_KEYS,
    enabled: enabled && key !== null,
  });
  const review = key ? query.data?.[key] : undefined;
  const [interner] = useState(() => new ReviewInterner());
  const stable = useMemo(() => interner.stable(review), [interner, review]);
  const refetch = useRef(query.refetch);
  useLayoutEffect(() => {
    refetch.current = query.refetch;
  });
  const retry = useMemo(() => () => void refetch.current(), []);
  return {
    review,
    stable,
    error: review === undefined && query.error ? query.error.message : null,
    refetch: retry,
  };
}

export type ReviewActions = {
  setSelected(ids: readonly string[], selected: boolean): void;
  /** Resolves once the server has the draft; rejects with what went wrong. */
  saveDraft(draft: DraftInput): Promise<void>;
  deleteDraft(id: string): Promise<void>;
};

function upsert(drafts: readonly Draft[], input: DraftInput): Draft[] {
  const old = drafts.find((draft) => draft.id === input.id);
  // Times are the server's; a prediction keeps the old ones, or none yet.
  const next: Draft = {
    ...input,
    state: "pending",
    createdAt: old?.createdAt ?? 0,
    updatedAt: old?.updatedAt ?? 0,
  };
  return old ? drafts.map((draft) => (draft.id === input.id ? next : draft)) : [...drafts, next];
}

/** The review's writes for one Change, as one object that never changes. */
export function useReviewActions(key: ChangeKey): ReviewActions {
  const select = useRpcMutation({
    contract: sourceControlContract,
    method: "setSelected",
    optimistic: (input, cache) =>
      cache.updateKey("reviewForChange", input.key, (current) => {
        if (!current) return current;
        const set = new Set(current.selected);
        for (const id of input.ids) {
          if (input.selected) set.add(id);
          else set.delete(id);
        }
        return { ...current, selected: [...set] };
      }),
  });
  const save = useRpcMutation({
    contract: sourceControlContract,
    method: "saveDraft",
    optimistic: (input, cache) =>
      cache.updateKey("reviewForChange", input.key, (current) =>
        current ? { ...current, drafts: upsert(current.drafts, input.draft) } : current,
      ),
  });
  const remove = useRpcMutation({
    contract: sourceControlContract,
    method: "deleteDraft",
    optimistic: (input, cache) =>
      cache.updateKey("reviewForChange", input.key, (current) =>
        current
          ? { ...current, drafts: current.drafts.filter((draft) => draft.id !== input.id) }
          : current,
      ),
  });
  const latest = useRef({ select: select.mutate, save: save.mutate, remove: remove.mutate });
  useLayoutEffect(() => {
    latest.current = { select: select.mutate, save: save.mutate, remove: remove.mutate };
  });
  return useMemo<ReviewActions>(
    () => ({
      setSelected(ids, selected) {
        if (ids.length === 0) return;
        // A failed write rolls its prediction back; the box shows what the server has.
        void latest.current.select({ key, ids: [...ids], selected }).catch(() => undefined);
      },
      async saveDraft(draft) {
        await latest.current.save({ key, draft });
      },
      async deleteDraft(id) {
        await latest.current.remove({ key, id });
      },
    }),
    [key],
  );
}

/** A new draft's id: minted once, so saving it again edits the same draft. */
export function newDraftId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `d-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
