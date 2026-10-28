// Whether the user has moved on from the reply holding a block: the thread
// has a user message after it. Every block of a thread shares one outline
// read and one realtime subscription; the outline is read again only when a
// thread event can add or drop a user message, so a streaming reply costs
// nothing. Works for blocks scrolled out of BB's virtualized timeline too,
// since it reads the thread from the server, not the DOM.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useSdk, type PluginBrowserBbSdk as Sdk } from "@get-bb/plugin-sdk/app";
import { affectsConversation, hasLaterUserMessage, type OutlineItem } from "./supersession";

/** Coalesces the burst of events a send produces into one read. */
const REFRESH_DELAY_MS = 150;
/** Keeps a thread's outline briefly after its last block unmounts, so scrolling back doesn't refetch. */
const RELEASE_DELAY_MS = 10_000;

interface ThreadEntry {
  items: readonly OutlineItem[] | null;
  readonly listeners: Set<() => void>;
  readonly unsubscribe: () => void;
  readonly abort: AbortController;
  /** A read is in flight. */
  fetching: boolean;
  /** Something changed while the read was in flight; read again after it. */
  stale: boolean;
  refreshTimer: number | undefined;
  releaseTimer: number | undefined;
}

class ThreadOutlines {
  private readonly entries = new Map<string, ThreadEntry>();
  private stopConnection: (() => void) | null = null;

  constructor(private readonly sdk: Sdk) {}

  items(threadId: string): readonly OutlineItem[] | null {
    return this.entries.get(threadId)?.items ?? null;
  }

  listen(threadId: string, listener: () => void): () => void {
    const entry = this.entries.get(threadId) ?? this.open(threadId);
    clearTimeout(entry.releaseTimer);
    entry.releaseTimer = undefined;
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) {
        entry.releaseTimer = window.setTimeout(() => this.close(threadId, entry), RELEASE_DELAY_MS);
      }
    };
  }

  private open(threadId: string): ThreadEntry {
    const entry: ThreadEntry = {
      items: null,
      listeners: new Set(),
      unsubscribe: this.sdk.subscribe({
        event: "thread:changed",
        threadId,
        callback: (change) => {
          if (affectsConversation(change)) this.schedule(entry, threadId);
        },
      }),
      abort: new AbortController(),
      fetching: false,
      stale: false,
      refreshTimer: undefined,
      releaseTimer: undefined,
    };
    this.entries.set(threadId, entry);
    // Events sent while the realtime link was down (or still connecting, on
    // first use) are not replayed: re-read whenever it comes up.
    this.stopConnection ??= this.sdk.subscribe({
      event: "realtime:connection",
      callback: ({ state }) => {
        if (state !== "connected") return;
        for (const [id, open] of this.entries) this.schedule(open, id);
      },
    });
    this.refresh(entry, threadId);
    return entry;
  }

  private close(threadId: string, entry: ThreadEntry): void {
    if (this.entries.get(threadId) !== entry || entry.listeners.size > 0) return;
    this.entries.delete(threadId);
    entry.unsubscribe();
    entry.abort.abort();
    clearTimeout(entry.refreshTimer);
    if (this.entries.size === 0) {
      this.stopConnection?.();
      this.stopConnection = null;
    }
  }

  private schedule(entry: ThreadEntry, threadId: string): void {
    if (entry.refreshTimer !== undefined) return;
    entry.refreshTimer = window.setTimeout(() => {
      entry.refreshTimer = undefined;
      this.refresh(entry, threadId);
    }, REFRESH_DELAY_MS);
  }

  private refresh(entry: ThreadEntry, threadId: string): void {
    if (entry.fetching) {
      entry.stale = true;
      return;
    }
    entry.fetching = true;
    entry.stale = false;
    this.sdk.threads
      .conversationOutline({ threadId, signal: entry.abort.signal })
      .then(
        ({ items }) => {
          entry.items = items.map(({ id, role }) => ({ id, role }));
          for (const listener of entry.listeners) listener();
        },
        // A failed read keeps the last outline; the next change reads again. Without one,
        // replies count as unanswered, as they did before any outline: not left provisional.
        () => {
          if (entry.items !== null || entry.abort.signal.aborted) return;
          entry.items = [];
          for (const listener of entry.listeners) listener();
        },
      )
      .finally(() => {
        entry.fetching = false;
        if (entry.stale && !entry.abort.signal.aborted) this.schedule(entry, threadId);
      });
  }
}

/**
 * Replies seen answered, by message id, kept across pages: an answer doesn't
 * go away, so a thread opened again (on a fresh page, or after its outline
 * was released) folds their choices on the first frame, at the height the
 * block settled at, instead of when the outline arrives.
 */
const ANSWERED_KEY = "bb.genui.answered";
const MAX_ANSWERED = 2000;
/** A thread opened again confirms many replies at once: they are written out together. */
const SAVE_DELAY_MS = 500;
let answered: Set<string> | null = null;
let saveTimer: number | undefined;

function answeredReplies(): Set<string> {
  if (answered === null) {
    answered = new Set();
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(ANSWERED_KEY) ?? "[]");
      if (Array.isArray(saved)) for (const id of saved) if (typeof id === "string") answered.add(id);
    } catch {
      // Unavailable or damaged: nothing is remembered.
    }
  }
  return answered;
}

function rememberAnswered(messageId: string, isAnswered: boolean): void {
  const replies = answeredReplies();
  if (replies.has(messageId) === isAnswered) return;
  if (isAnswered) replies.add(messageId);
  else replies.delete(messageId);
  while (replies.size > MAX_ANSWERED) replies.delete(replies.values().next().value!);
  saveTimer ??= window.setTimeout(() => {
    saveTimer = undefined;
    try {
      localStorage.setItem(ANSWERED_KEY, JSON.stringify([...replies]));
    } catch {
      // Storage full or unavailable: remembered for this page only.
    }
  }, SAVE_DELAY_MS);
}

/** What the outline says of a reply: not read yet, not listed (a nested agent's), answered or not. */
type OutlineVerdict = "pending" | "unlisted" | "answered" | "open";

function verdictOf(items: readonly OutlineItem[] | null, messageId: string): OutlineVerdict {
  if (items === null) return "pending";
  const later = hasLaterUserMessage(items, messageId);
  return later === null ? "unlisted" : later ? "answered" : "open";
}

/** The SDK client is stable for the plugin's lifetime; this keeps one store per client. */
const stores = new WeakMap<Sdk, ThreadOutlines>();

function outlinesFor(sdk: Sdk): ThreadOutlines {
  let store = stores.get(sdk);
  if (store === undefined) {
    store = new ThreadOutlines(sdk);
    stores.set(sdk, store);
  }
  return store;
}

/**
 * True once thread `threadId` has a user message after message `messageId`
 * (a conversation row id: the `message.id` BB hands to slots, or a timeline
 * row's `data-timeline-row-id`); false while the reply is the latest
 * exchange. Null while the outline is still being read for a reply not seen
 * answered before (on this page or an earlier one): the block doesn't know
 * yet whether its choices stay. When the outline doesn't list the message
 * (a nested agent's reply), keeps the last known answer, initially false.
 */
export function useSuperseded(threadId: string, messageId: string): boolean | null {
  const store = outlinesFor(useSdk());
  const subscribe = useCallback((listener: () => void) => store.listen(threadId, listener), [store, threadId]);
  const verdict = useSyncExternalStore(subscribe, () => verdictOf(store.items(threadId), messageId));
  const known = useRef<boolean | null>(null);
  if (verdict === "answered" || verdict === "open") known.current = verdict === "answered";
  useEffect(() => {
    if (verdict === "answered" || verdict === "open") rememberAnswered(messageId, verdict === "answered");
  }, [verdict, messageId]);
  if (known.current !== null) return known.current;
  if (answeredReplies().has(messageId)) return true;
  return verdict === "pending" ? null : false;
}

/**
 * Message `messageId`'s index in thread `threadId`'s conversation, from the
 * same shared outline; null until the outline lists it. Orders the answers
 * of several replies (ui/answerSheet.ts).
 */
export function useReplyIndex(threadId: string, messageId: string): number | null {
  const store = outlinesFor(useSdk());
  const subscribe = useCallback((listener: () => void) => store.listen(threadId, listener), [store, threadId]);
  return useSyncExternalStore(subscribe, () => {
    const index = store.items(threadId)?.findIndex((item) => item.id === messageId) ?? -1;
    return index === -1 ? null : index;
  });
}
