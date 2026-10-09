import { hashKey } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import type { z } from "zod";
import { baseHistorySchema, repositoriesSchema, workspaceSchema } from "../shared/schema.ts";
import { BASE_HISTORY_PAGE } from "./query-client.ts";
import { rpc } from "./rpc.ts";

/*
 * Answers worth drawing before the server replies, kept in localStorage.
 * Every read crosses bb and the environment's host, which takes from a third
 * of a second to over a second, and a cold panel used to spend that time on
 * "Loading workspace…". A stored answer is drawn at once and refetched
 * straight away, so it is the first frame, never the last word.
 *
 * Only reads that are cheap to be briefly wrong about are kept: a board that
 * read cleanly, the repository list, and the first page of base history,
 * which is addressed by commit and never changes. Diffs are not. They are
 * large, and memory already holds the ones opened this session.
 */

const PREFIX = "bb-plugin-gitbutler:query:v1:";
const INDEX = `${PREFIX}index`;
// localStorage is one 5 MB budget shared with bb and every other plugin.
const MAX_ENTRIES = 32;
const MAX_ENTRY_CHARS = 200_000;

type Rule<Schema extends z.ZodType> = {
  schema: Schema;
  /** Whether a read with this input is one worth storing at all. */
  applies: (input: unknown) => boolean;
  /** Whether this answer replaces the stored one. False drops it. */
  keep: (data: z.infer<Schema>) => boolean;
  /** An answer that says nothing about the stored one, which it neither replaces nor drops. */
  ignore?: (data: z.infer<Schema>) => boolean;
};

const RULES = {
  // A notice is quick to redraw and may be the fix the reader is waiting
  // for, so only a board replaces the stored one, and a notice clears it.
  // A failed read is the exception: one host hiccup says nothing about the
  // board, and the panel keeps drawing the last good one through it.
  workspace: {
    schema: workspaceSchema,
    applies: () => true,
    keep: (data) => data.state === "ready",
    ignore: (data) => data.state === "error",
  } satisfies Rule<typeof workspaceSchema>,
  repositories: {
    schema: repositoriesSchema,
    applies: () => true,
    keep: (data) => data.reason === null,
  } satisfies Rule<typeof repositoriesSchema>,
  baseHistory: {
    schema: baseHistorySchema,
    // The first page only. "Load more" pages are a longer key each, and
    // the reader who wants them again can ask again.
    applies: (input) => {
      const page = input as { offset?: number; limit?: number } | undefined;
      return page?.offset === 0 && page.limit === BASE_HISTORY_PAGE;
    },
    keep: (data) => data.reason === null,
  } satisfies Rule<typeof baseHistorySchema>,
};

type Method = keyof typeof RULES;
type Data<M extends Method> = z.infer<(typeof RULES)[M]["schema"]>;
type Input<M extends Method> = Parameters<(typeof rpc)[M]["queryKey"]>[0];
type Entry = { at: number; data: unknown };

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // An embedded browser can refuse storage. The panel then loads as it
    // always did, and nothing else changes.
    return null;
  }
}

function readIndex(store: Storage): string[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(INDEX) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function remove(store: Storage, hash: string): void {
  store.removeItem(`${PREFIX}${hash}`);
  try {
    store.setItem(INDEX, JSON.stringify(readIndex(store).filter((item) => item !== hash)));
  } catch {
    // An index naming an entry that is gone costs a lookup, nothing more.
  }
}

function write(store: Storage, hash: string, entry: Entry): void {
  const text = JSON.stringify(entry);
  if (text.length > MAX_ENTRY_CHARS) {
    remove(store, hash);
    return;
  }
  // Most recent first. What falls off the end is the thread least recently read.
  const index = [hash, ...readIndex(store).filter((item) => item !== hash)];
  for (const evicted of index.splice(MAX_ENTRIES)) store.removeItem(`${PREFIX}${evicted}`);
  try {
    store.setItem(`${PREFIX}${hash}`, text);
  } catch {
    // Over quota: give back the older half and try once more.
    for (const evicted of index.splice(Math.ceil(index.length / 2))) {
      store.removeItem(`${PREFIX}${evicted}`);
    }
    try {
      store.setItem(`${PREFIX}${hash}`, text);
    } catch {
      remove(store, hash);
      return;
    }
  }
  store.setItem(INDEX, JSON.stringify(index));
}

function ruleFor(queryKey: QueryKey): Rule<z.ZodType> | null {
  const [method, input] = queryKey;
  if (typeof method !== "string" || !Object.hasOwn(RULES, method)) return null;
  const rule = RULES[method as Method] as Rule<z.ZodType>;
  return rule.applies(input) ? rule : null;
}

function read(queryKey: QueryKey): Entry | undefined {
  const rule = ruleFor(queryKey);
  const store = storage();
  if (!rule || !store) return undefined;
  const hash = hashKey(queryKey);
  try {
    const entry = JSON.parse(store.getItem(`${PREFIX}${hash}`) ?? "null") as Entry | null;
    if (!entry || typeof entry.at !== "number") return undefined;
    // An answer stored by an older build may not fit this one's schema.
    const parsed = rule.schema.safeParse(entry.data);
    if (parsed.success && rule.keep(parsed.data)) return { at: entry.at, data: parsed.data };
  } catch {
    // Unreadable is the same as absent.
  }
  remove(store, hash);
  return undefined;
}

// What each key last wrote. A poll that finds nothing new hands back the same
// object, thanks to structural sharing, and is not written again.
const written = new Map<string, unknown>();

pluginQueryClient.getQueryCache().subscribe((event) => {
  if (event.type !== "updated" || event.action.type !== "success") return;
  const { queryKey, state } = event.query;
  const rule = ruleFor(queryKey);
  const store = storage();
  if (!rule || !store || rule.ignore?.(state.data)) return;
  const hash = hashKey(queryKey);
  if (written.get(hash) === state.data) return;
  if (written.size >= MAX_ENTRIES * 2) written.clear();
  written.set(hash, state.data);
  // Storage only speeds up the next cold open. A refusal from it must never
  // reach the query, whose answer is good either way.
  try {
    if (rule.keep(state.data)) write(store, hash, { at: state.dataUpdatedAt, data: state.data });
    else remove(store, hash);
  } catch {
    written.delete(hash);
  }
});

/**
 * Options that seed a query from its stored answer, dated when it was read.
 * They only act when the query is not in memory yet, and a stored answer is
 * as stale as its age says, so the query refetches it on mount.
 */
export function storedAnswer<M extends Method>(
  method: M,
  input: Input<M>,
): { initialData: () => Data<M> | undefined; initialDataUpdatedAt: () => number | undefined } {
  let entry: Entry | undefined | null = null;
  const once = () => {
    if (entry === null) entry = read(rpc[method].queryKey(input as never));
    return entry;
  };
  return {
    initialData: () => once()?.data as Data<M> | undefined,
    initialDataUpdatedAt: () => once()?.at,
  };
}

/** The stored answer for a read, if one is kept and still fits the schema. */
export function readStored<M extends Method>(method: M, input: Input<M>): Data<M> | undefined {
  return read(rpc[method].queryKey(input as never))?.data as Data<M> | undefined;
}
