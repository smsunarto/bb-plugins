// Each rendered UI's height as it last settled, per block and width, kept in
// localStorage. When a thread opens on a fresh page (the app started, the
// plugin reloaded), a block holds that height while the files it reads, its
// images and BB's answers arrive, so the reply is laid out at its final size
// at once instead of growing under the reader. Within a page, useLoadedData's
// cache already renders remounted blocks complete.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const STORAGE_KEY = "bb.genui.heights";
/** Blocks remembered, most recently settled kept. */
export const MAX_BLOCKS = 400;
/** Widths this close lay a block out alike. */
const WIDTH_TOLERANCE = 4;
/** A reservation the content hasn't filled by then is dropped: it is shorter now. */
const RESERVE_MS = 4000;
const PERSIST_MS = 500;

/** `[width, height]` in CSS px. */
type Entry = readonly [number, number];

/** What the store remembers, oldest first; `read` validates a stored copy. */
export class HeightStore {
  private readonly entries = new Map<string, Entry>();

  constructor(readonly max = MAX_BLOCKS) {}

  /** The height `key` settled at, when it was laid out at about `width`; any width when `width` is null. */
  get(key: string, width: number | null = null): number | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    return width === null || Math.abs(entry[0] - width) <= WIDTH_TOLERANCE ? entry[1] : null;
  }

  /** The `[width, height]` stored for `key`. */
  entry(key: string): Entry | null {
    return this.entries.get(key) ?? null;
  }

  set(key: string, width: number, height: number): void {
    this.entries.delete(key);
    this.entries.set(key, [Math.round(width), Math.round(height)]);
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }

  serialize(): string {
    return JSON.stringify([...this.entries]);
  }

  /** Entries from `serialize`; anything malformed is skipped. */
  static read(raw: string | null, max = MAX_BLOCKS): HeightStore {
    const store = new HeightStore(max);
    let parsed: unknown = null;
    try {
      parsed = raw === null ? null : JSON.parse(raw);
    } catch {
      // A damaged copy is an empty one.
    }
    if (!Array.isArray(parsed)) return store;
    for (const item of parsed) {
      if (!Array.isArray(item) || typeof item[0] !== "string" || !Array.isArray(item[1])) continue;
      const [width, height] = item[1] as unknown[];
      if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) store.set(item[0], width, height);
    }
    return store;
  }
}

/** A HeightStore kept in localStorage under `storageKey`: read on first use, written at most every PERSIST_MS. */
export function persistedStore(storageKey: string, max = MAX_BLOCKS) {
  let shared: HeightStore | null = null;
  let timer: number | undefined;
  const store = (): HeightStore => {
    if (shared === null) {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(storageKey);
      } catch {
        // Storage unavailable: nothing is remembered across pages.
      }
      shared = HeightStore.read(raw, max);
    }
    return shared;
  };
  return {
    store,
    /** Writes the store out after its next changes. */
    save(): void {
      timer ??= window.setTimeout(() => {
        timer = undefined;
        try {
          localStorage.setItem(storageKey, store().serialize());
        } catch {
          // Storage full or unavailable: the sizes hold for this page only.
        }
      }, PERSIST_MS);
    },
  };
}

const blocks = persistedStore(STORAGE_KEY);
const heights = blocks.store;

/** Records the height block `key` settled at, laid out at `width`; written to localStorage shortly after. */
export function rememberHeight(key: string, width: number, height: number): void {
  const store = heights();
  if (store.get(key, width) === Math.round(height)) return;
  store.set(key, width, height);
  blocks.save();
}

/** The height block `key` last settled at, laid out at about `width`; at any width when `width` is null. */
export function storedHeight(key: string, width: number | null = null): number | null {
  return heights().get(key, width);
}

/**
 * For a block keyed `key` whose files or images are `loading`: `content` goes on the
 * element wrapping what it renders (its natural height is what is remembered)
 * and `minHeight` on that element's parent. The reservation ends once the
 * content reaches it, or after RESERVE_MS with nothing left loading. While
 * the block is `provisional` (BB hasn't said yet whether its choices stay),
 * no height is remembered, but the reservation still ends as usual.
 */
export function useReservedHeight(key: string, loading: boolean, provisional = false) {
  const [reserve, setReserve] = useState<number | null>(() => heights().get(key));
  const reserved = useRef(reserve);
  reserved.current = reserve;
  const unsettled = useRef(loading || provisional);
  unsettled.current = loading || provisional;
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const content = useCallback((element: HTMLDivElement | null) => setNode(element), []);
  const settle = useCallback(
    (width: number, height: number) => {
      const held = reserved.current;
      if (held !== null && height >= held - 1) setReserve(null);
      // Heights seen while files or images arrive, while the block is provisional or under a reservation are not its own.
      if (!unsettled.current && (held === null || height >= held - 1)) rememberHeight(key, width, height);
    },
    [key],
  );

  useLayoutEffect(() => {
    if (node === null) return;

    // Laid out at another width (a narrower pane, a phone), the stored height doesn't apply.
    const width = node.getBoundingClientRect().width;
    if (reserved.current !== null && heights().get(key, width) === null) setReserve(null);
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.borderBoxSize?.[0];
      settle(box?.inlineSize ?? entry.contentRect.width, box?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, key, settle]);

  // Once nothing is left arriving, what shows is the block's own height, whether or not that resized it.
  const settled = !loading && !provisional;
  useEffect(() => {
    if (!settled || node === null) return;
    const box = node.getBoundingClientRect();
    settle(box.width, box.height);
  }, [settled, node, settle]);

  // Content that is shorter now never reaches the reservation: drop it, and remember the new height.
  useEffect(() => {
    if (reserve === null || loading || node === null) return;
    const timer = window.setTimeout(() => {
      const box = node.getBoundingClientRect();
      setReserve(null);
      if (!unsettled.current) rememberHeight(key, box.width, box.height);
    }, RESERVE_MS);
    return () => clearTimeout(timer);
  }, [reserve, loading, node, key]);

  return { content, minHeight: reserve ?? undefined };
}
