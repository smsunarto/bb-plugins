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
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ChangeKey } from "../core/ids.ts";
import type {
  BatchInput,
  BatchView,
  ChangeReview,
  Draft,
  DraftInput,
  Tray,
} from "../core/items.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { ReviewInterner, type StableReview } from "./review-model.ts";

const NO_KEYS: readonly string[] = [];

/**
 * Checks the reader made that the server has not shown back yet, by Change.
 * bb's shared keyed prediction drops an earlier accepted check when a later
 * one is predicted on the same Change, so the selection keeps its own: each
 * box shows the reader's choice from the click until a read agrees, the
 * write fails, or a few seconds pass, when the server's read is the truth.
 */
const PENDING_MS = 5_000;
const pendingChecks = new Map<ChangeKey, ReadonlyMap<string, boolean>>();
const pendingListeners = new Set<() => void>();

function setPending(key: ChangeKey, ids: readonly string[], selected: boolean | null): void {
  const next = new Map(pendingChecks.get(key));
  for (const id of ids) {
    if (selected === null) next.delete(id);
    else next.set(id, selected);
  }
  if (next.size === 0) pendingChecks.delete(key);
  else pendingChecks.set(key, next);
  for (const listener of pendingListeners) listener();
}

/** Drops the pending checks for `ids` that still say `selected`; a later click owns the rest. */
function clearPending(key: ChangeKey, ids: readonly string[], selected: boolean): void {
  const current = pendingChecks.get(key);
  const done = ids.filter((id) => current?.get(id) === selected);
  if (done.length > 0) setPending(key, done, null);
}

function subscribePending(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

/** The server's review with the reader's unconfirmed checks applied. */
function withPending(
  review: ChangeReview | undefined,
  pending: ReadonlyMap<string, boolean> | undefined,
): ChangeReview | undefined {
  if (!review || !pending) return review;
  const selected = new Set(review.selected);
  for (const [id, checked] of pending) {
    if (checked) selected.add(id);
    else selected.delete(id);
  }
  return selected.size === review.selected.length && review.selected.every((id) => selected.has(id))
    ? review
    : { ...review, selected: [...selected] };
}

/** For tests: forget every pending check. */
export function resetPendingChecks(): void {
  pendingChecks.clear();
}

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
  const read = key ? query.data?.[key] : undefined;
  const pending = useSyncExternalStore(subscribePending, () =>
    key ? pendingChecks.get(key) : undefined,
  );
  // A read that shows a pending check as the reader left it confirms it.
  useLayoutEffect(() => {
    if (!key || !read || !pending) return;
    const shown = new Set(read.selected);
    const agreed = [...pending].filter(([id, checked]) => shown.has(id) === checked);
    for (const checked of [true, false])
      clearPending(
        key,
        agreed.filter(([, value]) => value === checked).map(([id]) => id),
        checked,
      );
  }, [key, read, pending]);
  const review = useMemo(() => withPending(read, pending), [read, pending]);
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
  /** Removes a bb finding from the items, their counts and the selection at once. */
  dismissItem(id: string): Promise<void>;
  setTray(tray: Tray): void;
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
  // Predicted by the pending checks above, not by bb's keyed prediction.
  const select = useRpcMutation({ contract: sourceControlContract, method: "setSelected" });
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
  const dismiss = useRpcMutation({
    contract: sourceControlContract,
    method: "dismissItem",
    optimistic: (input, cache) =>
      cache.updateKey("reviewForChange", input.key, (current) =>
        current
          ? {
              ...current,
              items: current.items.filter((item) => item.id !== input.id),
              selected: current.selected.filter((id) => id !== input.id),
            }
          : current,
      ),
  });
  const tray = useRpcMutation({
    contract: sourceControlContract,
    method: "setTray",
    optimistic: (input, cache) =>
      cache.updateKey("reviewForChange", input.key, (current) =>
        current ? { ...current, tray: input.tray } : current,
      ),
  });
  const mutations = {
    select: select.mutate,
    save: save.mutate,
    remove: remove.mutate,
    dismiss: dismiss.mutate,
    tray: tray.mutate,
  };
  const latest = useRef(mutations);
  useLayoutEffect(() => {
    latest.current = mutations;
  });
  return useMemo<ReviewActions>(
    () => ({
      setSelected(ids, selected) {
        if (ids.length === 0) return;
        const list = [...ids];
        setPending(key, list, selected);
        // A failed write drops its prediction at once; the box shows what the server has.
        void latest.current.select({ key, ids: list, selected }).then(
          () => setTimeout(() => clearPending(key, list, selected), PENDING_MS),
          () => clearPending(key, list, selected),
        );
      },
      async saveDraft(draft) {
        await latest.current.save({ key, draft });
      },
      async deleteDraft(id) {
        await latest.current.remove({ key, id });
      },
      async dismissItem(id) {
        await latest.current.dismiss({ key, id });
      },
      setTray(next) {
        void latest.current.tray({ key, tray: next }).catch(() => undefined);
      },
    }),
    [key],
  );
}

// ── Sending ────────────────────────────────────────────────────────────

/** What a send asks for; the id is minted by `useSend`. */
export type SendRequest = Omit<BatchInput, "id">;

export type SendActions = {
  /**
   * Sends under a new batch id, or under the last id when the same request
   * failed to reach the server, so a repeated click can never send twice.
   */
  send(request: SendRequest): Promise<BatchView>;
  /** Sends a queued or failed batch again under its own id. */
  retry(batch: BatchView): Promise<BatchView>;
  stop(batchId: string): Promise<{ ok: true } | { ok: false; message: string }>;
};

/** The batch as the input that sent it, for Retry. */
export function batchInput(batch: BatchView): BatchInput {
  const { id, head, itemIds, draftIds, destination, target } = batch;
  return { id, head, itemIds, draftIds, destination, target };
}

function predicted(input: BatchInput, old: BatchView | undefined): BatchView {
  return {
    ...input,
    state: "sending",
    phase: "sending",
    problem: null,
    createdAt: old?.createdAt ?? 0,
    sentAt: null,
    threadId: old?.threadId ?? (input.target.kind === "thread" ? input.target.threadId : null),
    url: null,
    agent: null,
  };
}

/** A new batch id. */
export function newBatchId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `b-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/** Sending, retrying and stopping for one Change, as one object that never changes. */
export function useSend(key: ChangeKey): SendActions & { pending: boolean } {
  const mutation = useRpcMutation({
    contract: sourceControlContract,
    method: "sendBatch",
    optimistic: (input, cache) =>
      cache.updateKey("reviewForChange", input.key, (current) => {
        if (!current) return current;
        const old = current.batches.find((batch) => batch.id === input.batch.id);
        const next = predicted(input.batch, old);
        return {
          ...current,
          batches: [next, ...current.batches.filter((batch) => batch.id !== input.batch.id)],
        };
      }),
  });
  const stop = useRpcMutation({ contract: sourceControlContract, method: "stopAgent" });
  const latest = useRef({ send: mutation.mutate, stop: stop.mutate });
  useLayoutEffect(() => {
    latest.current = { send: mutation.mutate, stop: stop.mutate };
  });
  // The last request the server may not have seen, under the id it was sent with.
  const unconfirmed = useRef<{ id: string; json: string } | null>(null);
  const actions = useMemo<SendActions>(
    () => ({
      async send(request) {
        const json = JSON.stringify(request);
        const id = unconfirmed.current?.json === json ? unconfirmed.current.id : newBatchId();
        unconfirmed.current = { id, json };
        const batch = await latest.current.send({ key, batch: { ...request, id } });
        unconfirmed.current = null;
        return batch;
      },
      retry(batch) {
        return latest.current.send({ key, batch: batchInput(batch) });
      },
      stop(batchId) {
        return latest.current.stop({ key, batchId });
      },
    }),
    [key],
  );
  return useMemo(
    () => ({ ...actions, pending: mutation.isPending }),
    [actions, mutation.isPending],
  );
}

/** A new draft's id: minted once, so saving it again edits the same draft. */
export function newDraftId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `d-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
