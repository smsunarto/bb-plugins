/**
 * File patches of one Change at one revision. A revision is immutable, so a
 * patch read once is kept for the page's life and never read again. Files
 * ask for their patch as they near the viewport; the asks of one task are
 * batched into `changePatches` calls of at most 40 paths.
 *
 * Each store belongs to one (ChangeKey, revision): a late answer for Change
 * A lands in A's store and can never draw in B's pane.
 */
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { describeProblem, type FilePatch } from "../../core/change.ts";
import type { ChangeKey } from "../../core/ids.ts";
import type { ReviewRevision } from "../../core/review.ts";
import type { sourceControlContract } from "../../contract/rpc.ts";

export const PATCH_BATCH = 40;
/** Revisions kept at once; the least recently opened goes first. */
const KEPT = 12;

export type PatchEntry =
  | { state: "loading" }
  /** Null when the read had no patch for the path. */
  | { state: "ready"; file: FilePatch | null }
  | { state: "failed"; message: string };

type Read = (
  paths: string[],
) => Promise<
  | { ok: true; value: { files: FilePatch[] } }
  | { ok: false; problem: Parameters<typeof describeProblem>[0] }
>;

export class PatchStore {
  private readonly entries = new Map<string, PatchEntry>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly queue = new Set<string>();
  private scheduled = false;
  read: Read;

  constructor(read: Read) {
    this.read = read;
  }

  get(path: string): PatchEntry | undefined {
    return this.entries.get(path);
  }

  subscribe(path: string, listener: () => void): () => void {
    let set = this.listeners.get(path);
    if (!set) this.listeners.set(path, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(path);
    };
  }

  /** Ask for a path's patch. Ready and loading paths are not asked again; a failed one is. */
  request(path: string): void {
    const entry = this.entries.get(path);
    if (entry && entry.state !== "failed") return;
    this.set(path, { state: "loading" });
    this.queue.add(path);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  private set(path: string, entry: PatchEntry) {
    this.entries.set(path, entry);
    for (const listener of this.listeners.get(path) ?? []) listener();
  }

  private flush() {
    this.scheduled = false;
    const paths = [...this.queue];
    this.queue.clear();
    for (let index = 0; index < paths.length; index += PATCH_BATCH)
      void this.load(paths.slice(index, index + PATCH_BATCH));
  }

  private async load(batch: string[]) {
    try {
      const answer = await this.read(batch);
      if (!answer.ok) {
        const message = describeProblem(answer.problem);
        for (const path of batch) this.set(path, { state: "failed", message });
        return;
      }
      const byPath = new Map(answer.value.files.map((file) => [file.path, file]));
      for (const path of batch) this.set(path, { state: "ready", file: byPath.get(path) ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The request failed.";
      for (const path of batch) this.set(path, { state: "failed", message });
    }
  }
}

const stores = new Map<string, PatchStore>();

/** The revision's identity: what makes two patch reads the same read. */
export function revisionId(key: ChangeKey, revision: ReviewRevision): string {
  return JSON.stringify([key, revision.head, revision.base, revision.source]);
}

/** Only for tests. */
export function resetPatchStores(): void {
  stores.clear();
}

export function usePatchStore(key: ChangeKey, revision: ReviewRevision): PatchStore {
  const rpc = useRpc<typeof sourceControlContract>();
  const id = revisionId(key, revision);
  const store = useMemo(() => {
    let found = stores.get(id);
    if (found) stores.delete(id);
    else {
      const parsed = JSON.parse(id) as [ChangeKey, string, string, ReviewRevision["source"]];
      const at: ReviewRevision = { head: parsed[1], base: parsed[2], source: parsed[3] };
      found = new PatchStore((paths) =>
        rpc.call("changePatches", { key: parsed[0], revision: at, paths }),
      );
    }
    stores.set(id, found);
    while (stores.size > KEPT) stores.delete(stores.keys().next().value!);
    return found;
  }, [id, rpc]);
  return store;
}

export function usePatch(store: PatchStore, path: string): PatchEntry | undefined {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(path, listener),
    [store, path],
  );
  const get = useCallback(() => store.get(path), [store, path]);
  return useSyncExternalStore(subscribe, get, get);
}
