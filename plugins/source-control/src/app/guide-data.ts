/**
 * One Change's guide and viewed marks, read through the keyed
 * `guideForChange` query every surface shares, and the writes that change
 * them. Reading never starts a guide run; only the review page's
 * `useOpenGuide` does, once per Change it opens.
 *
 * Viewed marks keep their own pending overlay, as the review's checks do
 * (see review-data.ts): bb's keyed prediction dropped an earlier accepted
 * write when a second was predicted on the same key, so a tick shows the
 * reader's choice from the click until a read agrees, the write fails, or a
 * few seconds pass.
 */
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { GuideView, Viewed } from "../core/guide.ts";
import type { ChangeKey } from "../core/ids.ts";
import { sourceControlContract } from "../contract/rpc.ts";

const NO_KEYS: readonly string[] = [];
const PENDING_MS = 5_000;

const markKey = (path: string, blob: string) => `${path}\u0000${blob}`;

/** Marks the reader made that no read has shown back yet: by Change, then `path\0blob`. */
const pendingMarks = new Map<ChangeKey, ReadonlyMap<string, Viewed & { viewed: boolean }>>();
const listeners = new Set<() => void>();

function setPending(key: ChangeKey, mark: Viewed, viewed: boolean | null): void {
  const next = new Map(pendingMarks.get(key));
  if (viewed === null) next.delete(markKey(mark.path, mark.blob));
  else next.set(markKey(mark.path, mark.blob), { ...mark, viewed });
  if (next.size === 0) pendingMarks.delete(key);
  else pendingMarks.set(key, next);
  for (const listener of listeners) listener();
}

/** Drops the pending mark if it still says `viewed`; a later click owns it otherwise. */
function clearPending(key: ChangeKey, mark: Viewed, viewed: boolean): void {
  if (pendingMarks.get(key)?.get(markKey(mark.path, mark.blob))?.viewed === viewed)
    setPending(key, mark, null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests: forget every pending mark. */
export function resetPendingViewed(): void {
  pendingMarks.clear();
}

function withPending(
  view: GuideView | undefined,
  pending: ReadonlyMap<string, Viewed & { viewed: boolean }> | undefined,
): GuideView | undefined {
  if (!view || !pending) return view;
  const marks = new Map(view.viewed.map((mark) => [markKey(mark.path, mark.blob), mark]));
  let changed = false;
  for (const [id, mark] of pending) {
    if (mark.viewed === marks.has(id)) continue;
    changed = true;
    if (mark.viewed) marks.set(id, { path: mark.path, blob: mark.blob });
    else marks.delete(id);
  }
  return changed ? { ...view, viewed: [...marks.values()] } : view;
}

export type GuideRead = {
  /** Undefined until the first read answers. */
  view: GuideView | undefined;
  error: string | null;
  refetch(): void;
};

/** The Change's guide with the reader's unconfirmed viewed marks applied. Never starts a run. */
export function useGuide(key: ChangeKey | null, enabled = true): GuideRead {
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "guideForChange",
    keys: key ? [key] : NO_KEYS,
    enabled: enabled && key !== null,
  });
  const read = key ? query.data?.[key] : undefined;
  const pending = useSyncExternalStore(subscribe, () => (key ? pendingMarks.get(key) : undefined));
  // A read that shows a pending mark as the reader left it confirms it.
  useLayoutEffect(() => {
    if (!key || !read || !pending) return;
    const shown = new Set(read.viewed.map((mark) => markKey(mark.path, mark.blob)));
    for (const [id, mark] of pending)
      if (shown.has(id) === mark.viewed) clearPending(key, mark, mark.viewed);
  }, [key, read, pending]);
  const view = useMemo(() => withPending(read, pending), [read, pending]);
  const refetch = useRef(query.refetch);
  useLayoutEffect(() => {
    refetch.current = query.refetch;
  });
  const retry = useMemo(() => () => void refetch.current(), []);
  return {
    view,
    error: view === undefined && query.error ? query.error.message : null,
    refetch: retry,
  };
}

export type ViewedActions = {
  /** Marks `path` viewed or not at `blob`, the file's `viewedBlob`. */
  setViewed(path: string, blob: string, viewed: boolean): void;
};

/** The viewed writes for one Change, as one object that never changes. */
export function useViewedActions(key: ChangeKey): ViewedActions {
  // Predicted by the pending marks above, never by bb's keyed prediction.
  const mutation = useRpcMutation({ contract: sourceControlContract, method: "setViewed" });
  const mutate = useRef(mutation.mutate);
  useLayoutEffect(() => {
    mutate.current = mutation.mutate;
  });
  return useMemo<ViewedActions>(
    () => ({
      setViewed(path, blob, viewed) {
        const mark = { path, blob };
        setPending(key, mark, viewed);
        // A failed write drops its prediction at once; the box shows what the server has.
        void mutate.current({ key, path, blob, viewed }).then(
          () => setTimeout(() => clearPending(key, mark, viewed), PENDING_MS),
          () => clearPending(key, mark, viewed),
        );
      },
    }),
    [key],
  );
}

/**
 * Starts the Change's one guide run if it has none: the review page calls
 * this once for the Change it opens, and no other surface calls it. Waits
 * until `ready` (the Change is known), then asks once for this mount.
 */
export function useOpenGuide(key: ChangeKey, ready: boolean): void {
  const mutation = useRpcMutation({ contract: sourceControlContract, method: "openGuide" });
  const mutate = useRef(mutation.mutate);
  useLayoutEffect(() => {
    mutate.current = mutation.mutate;
  });
  const asked = useRef(false);
  useEffect(() => {
    if (!ready || asked.current) return;
    asked.current = true;
    // The server answers with the run's state and marks the guide's tag stale; reads refresh from that.
    void mutate.current({ key }).catch(() => undefined);
  }, [key, ready]);
}

export type Rewrite = {
  rewrite(): void;
  pending: boolean;
  error: string | null;
};

/** "Rewrite guide" and "Try again": a new run for the Change's current head. */
export function useRewriteGuide(key: ChangeKey): Rewrite {
  const mutation = useRpcMutation({ contract: sourceControlContract, method: "rewriteGuide" });
  const mutate = useRef(mutation.mutate);
  useLayoutEffect(() => {
    mutate.current = mutation.mutate;
  });
  const rewrite = useMemo(() => () => void mutate.current({ key }).catch(() => undefined), [key]);
  return {
    rewrite,
    pending: mutation.isPending,
    error: mutation.error ? mutation.error.message : null,
  };
}
