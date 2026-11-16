/**
 * One Change's review, read through the keyed `reviewForChange` query that
 * the rail, the diff's annotations and the thread tab's card all share, and
 * the writes that change it. Writes show at once, so a checkbox ticked
 * anywhere is ticked everywhere; the server's next read is the truth and
 * replaces the prediction.
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

// ── Pending writes ─────────────────────────────────────────────────────

/**
 * Writes the reader made that the server has not shown back yet. bb's keyed
 * prediction loses an earlier accepted write when a later one is predicted on
 * the same Change, so a second check unticked the first and a second comment
 * replaced the first until a reload. The review keeps its own predictions
 * instead: each shows from the click until a read agrees, the write fails, or
 * a few seconds after it succeeds, when the server's read is the truth.
 * workaround:source-control/keyed-prediction-drop
 */
const PENDING_MS = 5_000;
const listeners = new Set<() => void>();

function subscribePending(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One kind of write: how it shows on a read, and when a read shows it done. */
type PendingKind<V> = {
  apply(review: ChangeReview, pending: ReadonlyMap<string, V>): ChangeReview;
  agrees(read: ChangeReview, id: string, value: V): boolean;
};

/** A kind's pending writes, by Change and id. */
class PendingWrites<V> {
  private byKey = new Map<ChangeKey, ReadonlyMap<string, V>>();
  readonly kind: PendingKind<V>;
  constructor(kind: PendingKind<V>) {
    this.kind = kind;
  }

  get(key: ChangeKey): ReadonlyMap<string, V> | undefined {
    return this.byKey.get(key);
  }

  /** Shows `value` for `id`; undefined drops it. */
  set(key: ChangeKey, id: string, value: V | undefined): void {
    const next = new Map(this.byKey.get(key));
    if (value === undefined) next.delete(id);
    else next.set(id, value);
    if (next.size === 0) this.byKey.delete(key);
    else this.byKey.set(key, next);
    for (const listener of listeners) listener();
  }

  /** Drops `id` while it still shows `value`; a later write of it owns the entry. */
  clear(key: ChangeKey, id: string, value: V): void {
    if (this.byKey.has(key) && this.byKey.get(key)!.get(id) === value) this.set(key, id, undefined);
  }

  /** Shows a write at once; a failed one drops it, a done one hands over to the reads. */
  async write(key: ChangeKey, id: string, value: V, send: () => Promise<unknown>): Promise<void> {
    this.set(key, id, value);
    try {
      await send();
    } catch (error) {
      this.clear(key, id, value);
      throw error;
    }
    setTimeout(() => this.clear(key, id, value), PENDING_MS);
  }

  /** Drops what `read` already shows. */
  confirm(key: ChangeKey, read: ChangeReview): void {
    for (const [id, value] of this.byKey.get(key) ?? [])
      if (this.kind.agrees(read, id, value)) this.clear(key, id, value);
  }

  reset(): void {
    this.byKey.clear();
  }
}

/** A box the reader checked (true) or unchecked (false). */
const checks = new PendingWrites<boolean>({
  apply(review, pending) {
    const selected = new Set(review.selected);
    for (const [id, checked] of pending) {
      if (checked) selected.add(id);
      else selected.delete(id);
    }
    return selected.size === review.selected.length &&
      review.selected.every((id) => selected.has(id))
      ? review
      : { ...review, selected: [...selected] };
  },
  agrees: (read, id, checked) => read.selected.includes(id) === checked,
});

/** A draft the reader saved (its input) or deleted (null). */
const drafts = new PendingWrites<DraftInput | null>({
  apply(review, pending) {
    const next: Draft[] = [];
    for (const draft of review.drafts) {
      if (!pending.has(draft.id)) next.push(draft);
      else {
        const input = pending.get(draft.id);
        // Times are the server's; an edit keeps them.
        if (input) next.push({ ...draft, ...input, state: "pending" });
      }
    }
    for (const [id, input] of pending)
      if (input && !review.drafts.some((draft) => draft.id === id))
        next.push({ ...input, state: "pending", createdAt: 0, updatedAt: 0 });
    return { ...review, drafts: next };
  },
  agrees(read, id, value) {
    const shown = read.drafts.find((draft) => draft.id === id);
    if (value === null) return shown === undefined;
    return shown !== undefined && shown.body === value.body && shown.replyTo === value.replyTo;
  },
});

/** An item the reader dismissed: gone from the items and the selection. */
const dismissals = new PendingWrites<true>({
  apply: (review, pending) => ({
    ...review,
    items: review.items.filter((item) => !pending.has(item.id)),
    selected: review.selected.filter((id) => !pending.has(id)),
  }),
  agrees: (read, id) => !read.items.some((item) => item.id === id),
});

/** For tests: forget every pending write. */
export function resetPendingWrites(): void {
  checks.reset();
  drafts.reset();
  dismissals.reset();
}

/** The server's review with one kind's pending writes applied. */
function withPending<V>(
  review: ChangeReview | undefined,
  writes: PendingWrites<V>,
  pending: ReadonlyMap<string, V> | undefined,
): ChangeReview | undefined {
  return review && pending ? writes.kind.apply(review, pending) : review;
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
  const checked = useSyncExternalStore(subscribePending, () => (key ? checks.get(key) : undefined));
  const saved = useSyncExternalStore(subscribePending, () => (key ? drafts.get(key) : undefined));
  const dismissed = useSyncExternalStore(subscribePending, () =>
    key ? dismissals.get(key) : undefined,
  );
  // A read that shows a pending write as the reader left it confirms it.
  useLayoutEffect(() => {
    if (!key || !read || !(checked || saved || dismissed)) return;
    checks.confirm(key, read);
    drafts.confirm(key, read);
    dismissals.confirm(key, read);
  }, [key, read, checked, saved, dismissed]);
  const review = useMemo(
    () =>
      withPending(
        withPending(withPending(read, checks, checked), drafts, saved),
        dismissals,
        dismissed,
      ),
    [read, checked, saved, dismissed],
  );
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
  /** Removes a finding or a sent comment from the items, their counts and the selection at once. */
  dismissItem(id: string): Promise<void>;
  setTray(tray: Tray): void;
  /** Resolves once the server has the draft; rejects with what went wrong. */
  saveDraft(draft: DraftInput): Promise<void>;
  deleteDraft(id: string): Promise<void>;
};

/** The review's writes for one Change, as one object that never changes. */
export function useReviewActions(key: ChangeKey): ReviewActions {
  // Checks, drafts and dismissals are predicted by the pending writes above, not by bb's.
  const select = useRpcMutation({ contract: sourceControlContract, method: "setSelected" });
  const save = useRpcMutation({ contract: sourceControlContract, method: "saveDraft" });
  const remove = useRpcMutation({ contract: sourceControlContract, method: "deleteDraft" });
  const dismiss = useRpcMutation({ contract: sourceControlContract, method: "dismissItem" });
  // One value, so the last prediction is the right one.
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
        const list = [...ids];
        if (list.length === 0) return;
        for (const id of list) checks.set(key, id, selected);
        // A failed write drops its prediction at once; the box shows what the server has.
        void latest.current.select({ key, ids: list, selected }).then(
          () =>
            setTimeout(() => {
              for (const id of list) checks.clear(key, id, selected);
            }, PENDING_MS),
          () => {
            for (const id of list) checks.clear(key, id, selected);
          },
        );
      },
      saveDraft: (draft) =>
        drafts.write(key, draft.id, draft, () => latest.current.save({ key, draft })),
      deleteDraft: (id) => drafts.write(key, id, null, () => latest.current.remove({ key, id })),
      dismissItem: (id) =>
        dismissals.write(key, id, true, () => latest.current.dismiss({ key, id })),
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
