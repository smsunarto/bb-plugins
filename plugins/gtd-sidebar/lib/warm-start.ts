/**
 * The last known good shelves, kept where a fresh mount can read them before
 * it paints.
 *
 * bb renders a different component for the settings routes, so the whole
 * thread list unmounts and comes back with every piece of local state reset —
 * while bb's own thread data returns from its cache instantly. That asymmetry
 * is the flicker: for one RPC round trip there are no rows, so every parked
 * thread reads as active, and a settled thread is filtered out of the list
 * altogether before it pops back onto its shelf.
 *
 * Two tiers, and each covers a case the other cannot. The module-level tier
 * outlives a component unmount and is the only one still standing when
 * `localStorage` throws or is not there at all; `localStorage` outlives the
 * page itself, which is the half that makes a cold app start paint correctly.
 * Memory is read first, because a `setItem` that failed leaves the store
 * holding the older value and only memory holding the newer one. The one thing
 * memory cannot see is another WINDOW's write, and the settings route is
 * exactly where that bites: bb unmounts the list there and takes its
 * `lifecycle` subscription with it, so a window parked on settings is told
 * nothing about a thread settled next door. A `storage` event fires in every
 * other document on the origin, so a foreign write drops the entry it names
 * and the next read falls through to the fresher copy.
 *
 * Neither tier is asked to be right, only to be a better first guess than
 * nothing. Snooze wake times are absolute, so a stale row still classifies
 * correctly against a fresh clock, and the mount read corrects the rest.
 *
 * Nothing here reads a clock or trusts what it decodes. `localStorage` is
 * user-writable and shared with every other script on the origin, so a decode
 * is a validation boundary at least as strict as the RPC schema it mirrors —
 * and it must never throw. It runs inside a `useState` initializer, and a
 * throw during render makes bb retire the plugin for the whole session and
 * fall back to its built-in list; a poisoned entry would do that on every
 * mount, surviving reload and reinstall, with no way for the dead plugin to
 * clear the value that killed it.
 *
 * The cost, stated plainly because it is the one thing `server.ts` cannot
 * promise any more: thread ids, park timestamps, and provider ids, names and
 * logo paths leave the plugin's own SQLite file. They land in origin-global
 * web storage that bb's uninstall does not clear and every other installed
 * plugin can read.
 */

import type { ThreadLifecycleRow } from "@/lib/lifecycle";

// Version first, matching `pr-walkthrough:v1:` — the repo's other storage
// user — and so a whole version can be retired by prefix scan. A bump retires
// the old entry instead of mis-reading data of the wrong shape; whoever writes
// v2 should `removeItem` these two on its first successful write, because
// nothing else on this origin ever will.
export const WARM_START_ROWS_KEY = "gtd-sidebar:v1:lifecycle-rows";
export const WARM_START_PROVIDERS_KEY = "gtd-sidebar:v1:providers";

/**
 * What this plugin wrote under its old name, t3sidebar.
 *
 * A rename is a prefix retirement with none of a version bump's cover: bb
 * installs the renamed plugin under a new id, so the old install's uninstall
 * never runs and no later version of this file is ever asked for those keys
 * again. Nothing else on the origin will reclaim the space, so the first
 * successful write does it — the same discipline the comment above prescribes
 * for whoever writes v2.
 */
const RETIRED_KEYS = ["t3sidebar:v1:lifecycle-rows", "t3sidebar:v1:providers"] as const;

/** The `Storage` methods this needs, so a test can hand it a stub. */
export type WarmStartStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The provider fields the glyph needs, mirroring `listProviders`' output. */
export interface WarmStartProvider {
  id: string;
  displayName: string;
  logoUrl: string | null;
}

// The serialized string rather than the decoded value: it is what makes a
// repeat write cheap to recognise, and it hands no shared mutable array to a
// caller that is free to sort it.
const memoryTier = new Map<string, string>();

/**
 * What the store is known to hold, tracked apart from the memory tier because
 * the two diverge at exactly the moment it matters. A `setItem` that throws
 * leaves the value in memory and not in storage, and a dedupe against memory
 * would then read the write as already done and never offer it to the store
 * again — so a quota that filled once and freed a minute later would keep
 * serving the stale entry to every later page load, which is the cold-start
 * half of the bug this file exists for.
 */
const persistedTier = new Map<string, string>();

/**
 * Drops both module-level tiers. Only a test needs this — memory surviving is
 * the entire point of it — but tests in one file share this module, and the
 * name says who the audience is because nothing stops another module importing
 * it and quietly throwing away the tier that fixes the remount.
 */
export function resetWarmStartMemoryForTests(): void {
  memoryTier.clear();
  persistedTier.clear();
  retiredOldName = false;
}

/**
 * Drops a memory entry another document has just rewritten.
 *
 * `storage` fires only in the OTHER documents on the origin, never in the one
 * that wrote, so this never fights our own writes. Registered once and never
 * removed: the tiers it guards are module-level and live as long as the page.
 */
let watchingForeignWrites = false;
function watchForeignWrites(): void {
  if (watchingForeignWrites) return;
  watchingForeignWrites = true;
  try {
    window.addEventListener("storage", (event) => {
      // A null key means the whole store was cleared, which invalidates every
      // entry rather than one.
      if (event.key === null) {
        memoryTier.clear();
        persistedTier.clear();
        return;
      }
      memoryTier.delete(event.key);
      persistedTier.delete(event.key);
    });
  } catch {
    // Without the listener memory simply stays authoritative for this window,
    // which is what it was before the listener existed.
  }
}

function defaultStorage(): WarmStartStorage | null {
  try {
    // A bare `window` reference throws a ReferenceError that optional chaining
    // would not catch, and reading `.localStorage` throws on its own where
    // storage is disabled or partitioned.
    if (typeof window === "undefined") return null;
    const storage = window.localStorage;
    watchForeignWrites();
    return storage;
  } catch {
    // No storage at all is a supported state: the memory tier still serves.
    return null;
  }
}

function readEntry(key: string, storage: WarmStartStorage | null): string | null {
  const remembered = memoryTier.get(key);
  if (remembered !== undefined) return remembered;
  if (storage === null) return null;
  try {
    return storage.getItem(key);
  } catch {
    // A store that refuses to be read is the same as an empty one here.
    return null;
  }
}

function writeEntry(key: string, serialized: string, storage: WarmStartStorage | null): void {
  memoryTier.set(key, serialized);
  if (storage === null) return;
  // Every mutation in every window publishes, and every window rewrites on the
  // response its own publish triggers. Recognising a value the store already
  // holds keeps a synchronous `setItem` off each of them.
  if (persistedTier.get(key) === serialized) return;
  try {
    storage.setItem(key, serialized);
    persistedTier.set(key, serialized);
    retireOldNameEntries(storage);
  } catch {
    // Quota is shared with bb's own keys, so a full store is ordinary rather
    // than exceptional. Memory carries this session on its own; forgetting
    // what the store holds is what makes the next write offer the value again
    // instead of recognising it as already written.
    persistedTier.delete(key);
  }
}

/**
 * Runs once per page, after a write has proven the store accepts writes at
 * all. Doing it on read instead would spend two `removeItem` calls on the
 * cold-start path this file exists to keep short, and a store too full to
 * accept the write is one where freeing these two entries is worth the most —
 * so the next write, not this one, is what retries.
 */
// Reset by resetWarmStartMemoryForTests, which is where every other
// module-level tier is cleared.
let retiredOldName = false;
function retireOldNameEntries(storage: WarmStartStorage): void {
  if (retiredOldName) return;
  retiredOldName = true;
  for (const key of RETIRED_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // A store that refuses the removal keeps the stale entry; it is dead
      // weight on the origin, not something this plugin will ever read.
    }
  }
}

function forgetEntry(key: string, storage: WarmStartStorage | null): void {
  memoryTier.delete(key);
  persistedTier.delete(key);
  if (storage === null) return;
  try {
    storage.removeItem(key);
  } catch {
    // Nothing to do; the next read simply fails to decode again.
  }
}

/**
 * A stored timestamp, or null for a field that is legitimately absent.
 * Anything else reads as undefined, which rejects the row it came from.
 *
 * `typeof value === "number"` is not enough on its own. `1e999` parses to
 * Infinity and passes it: the snooze then never elapses, so the thread stays
 * hidden for good and the slim row prints "Infinityd". `-1e999` fails the
 * other way and wakes the thread the moment it is read. (NaN cannot arrive —
 * JSON has no literal for it and `JSON.parse` is the only way in.)
 *
 * The bar is the one `snooze` sets on its INPUT, `z.number().int().positive()`,
 * so nothing legitimate ever stored anything else. It is not a bar the wire
 * enforces on the way back: `listLifecycle` declares these fields as plain
 * `z.number().nullable()`, which makes this the only check on the path.
 */
function decodeTimestamp(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  return undefined;
}

function decodeRow(value: unknown): ThreadLifecycleRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const threadId = raw.threadId;
  if (typeof threadId !== "string" || threadId.trim().length === 0) return null;
  const settledAt = decodeTimestamp(raw.settledAt);
  const snoozedUntil = decodeTimestamp(raw.snoozedUntil);
  const snoozedAt = decodeTimestamp(raw.snoozedAt);
  if (settledAt === undefined || snoozedUntil === undefined || snoozedAt === undefined) {
    return null;
  }
  return { threadId, settledAt, snoozedUntil, snoozedAt };
}

/**
 * How many rows an entry may carry, and the one place this cache is knowingly
 * incomplete.
 *
 * `thread.deleted` only fires while the plugin is running, so a thread deleted
 * while it was stopped leaves its row behind for good; unbounded, that grows an
 * entry nobody prunes inside a quota shared with bb's own keys. Newest park
 * first — by when it was made, which is what `parkedAt` exists to say — because
 * a park made minutes ago is the one whose shelf the user still has in mind.
 *
 * Past the cap the tail simply does not warm-start, and that costs something
 * rather than nothing. A snoozed row over the line renders in the Inbox for one
 * round trip and then jumps onto its shelf — the exact behaviour this file
 * removes for every row under the cap. A settled row over the line costs a
 * line of arithmetic instead: nothing can draw the thread until
 * `listSettledThreads` lands either way, but the collapsed shelf counts the
 * rows it is still waiting for, so a row past the cap leaves that header one
 * short until the slower read arrives.
 */
export const MAX_WARM_START_ROWS = 200;

/**
 * How long a stored entry may be before it is discarded unread.
 *
 * The parse runs inside a `useState` initializer — during render, holding up
 * the first paint this whole file exists to make correct — and the length of
 * the string is the only thing known about its cost before `JSON.parse` has
 * already paid it. Measured in UTF-16 units, which is what `localStorage`
 * charges against its quota too. Nothing written here comes near it: a full
 * `MAX_WARM_START_ROWS` serializes to roughly 18k.
 */
export const MAX_WARM_START_ENTRY_CHARS = 64 * 1024;

/**
 * Stored rows, or null when there is nothing trustworthy to read.
 *
 * The two answers a caller has to keep apart are a miss — nothing stored, or
 * stored junk — and a hit that legitimately holds no rows. Having nothing
 * parked is the common case, and reading it as a miss would blank the list on
 * every start for most users. So an empty array is a value and null is the
 * miss.
 *
 * One bad row rejects the whole payload. Half-accepting is the failure that
 * hurts: settling archives a thread in bb, so a dropped row does not make its
 * thread read active, it makes the thread vanish from the sidebar entirely.
 * An over-long payload is rejected the same way and for the same reason — the
 * encoder never writes one, so anything over the cap was written by something
 * that is not this plugin.
 */
export function decodeWarmStartRows(stored: string | null): ThreadLifecycleRow[] | null {
  if (stored === null) return null;
  if (stored.length > MAX_WARM_START_ENTRY_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    // Truncated or hand-edited. There is no repairing it, only discarding it.
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (parsed.length > MAX_WARM_START_ROWS) return null;
  const rows: ThreadLifecycleRow[] = [];
  for (const entry of parsed) {
    const row = decodeRow(entry);
    if (row === null) return null;
    rows.push(row);
  }
  return rows;
}

/**
 * When the park was MADE — pointedly not when a snooze ends.
 *
 * `snoozedUntil` is an absolute future time, so "Next week" scores about now+7d
 * while a settle made this morning scores about now. Ranking on it would sort
 * every snoozed row above every settled one whatever the user touched last, and
 * at the cap that stops being an ordering quibble: the rows dropped would be
 * exactly the ones the collapsed Settled header is counted from, so the user
 * with enough parked state to reach the cap at all is the one whose settled
 * shelf goes back to popping in a round trip late.
 */
function parkedAt(row: ThreadLifecycleRow): number {
  return Math.max(row.settledAt ?? 0, row.snoozedAt ?? 0);
}

/**
 * Rows as an array, exactly the shape `listLifecycle` returns, so the write
 * site needs no adaptation layer.
 *
 * An array is also the only shape that survives the trip: `JSON.stringify` of
 * a Map is the string "{}", and a plain object keyed by thread id would hoist
 * integer-like keys and answer to `Object.prototype` members.
 */
export function encodeWarmStartRows(rows: readonly ThreadLifecycleRow[]): string {
  const kept = [...rows]
    .sort(
      (left, right) =>
        parkedAt(right) - parkedAt(left) || left.threadId.localeCompare(right.threadId),
    )
    .slice(0, MAX_WARM_START_ROWS);
  return JSON.stringify(
    kept.map(({ threadId, settledAt, snoozedUntil, snoozedAt }) => ({
      threadId,
      settledAt,
      snoozedUntil,
      snoozedAt,
    })),
  );
}

export function readWarmStartRows(
  storage: WarmStartStorage | null = defaultStorage(),
): ThreadLifecycleRow[] | null {
  const stored = readEntry(WARM_START_ROWS_KEY, storage);
  if (stored === null) return null;
  const rows = decodeWarmStartRows(stored);
  if (rows === null) {
    // What did not decode now will not decode later either, and it would sit
    // there being re-read on every mount for the life of the origin.
    forgetEntry(WARM_START_ROWS_KEY, storage);
    return null;
  }
  return rows;
}

export function writeWarmStartRows(
  rows: readonly ThreadLifecycleRow[],
  storage: WarmStartStorage | null = defaultStorage(),
): void {
  writeEntry(WARM_START_ROWS_KEY, encodeWarmStartRows(rows), storage);
}

/**
 * Any absolute base will do: only whether the value stays on it is being
 * asked, and asking `window` for the real one would make a pure decode need a
 * DOM. `.invalid` is reserved by RFC 2606, so it can never name a real host.
 */
const LOGO_URL_BASE = "https://gtd-sidebar.invalid";

/**
 * A logo the host serves, and nothing else.
 *
 * bb serves these as same-origin paths (`/api/v1/system/providers/<id>/logo`),
 * and the glyph both probes the value with an `Image` and interpolates it into
 * a CSS `url("…")`, so a poisoned entry is a fetch to an arbitrary host on
 * every render of every row using that provider. A leading-slash test does not
 * stop that, twice over: `/\evil.test/x.svg` starts with one slash and still
 * resolves to `https://evil.test/x.svg`, because URL parsing reads a backslash
 * as a slash; and `/x.svg"), url("https://evil.test/x.svg` closes the CSS token
 * and opens a second mask layer the browser fetches on its own.
 *
 * So the value is resolved and kept only if it lands back on the base it was
 * resolved against, and what is returned is re-serialized from that parse
 * rather than passed through. The characters that end a CSS token are refused
 * outright rather than percent-encoded, because a value carrying one was never
 * a logo path to begin with.
 *
 * Only the URL is dropped, never the provider carrying it: `ProviderGlyph`
 * falls through to this plugin's own marks for a null logo, and the fresh
 * `listProviders` supplies the real one a moment later.
 */
function decodeLogoUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/")) return null;
  if (/["'()\\\s]/.test(value)) return null;
  let resolved: URL;
  try {
    resolved = new URL(value, LOGO_URL_BASE);
  } catch {
    return null;
  }
  if (resolved.origin !== LOGO_URL_BASE) return null;
  return `${resolved.pathname}${resolved.search}`;
}

function decodeProvider(value: unknown): WarmStartProvider | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = raw.id;
  const displayName = raw.displayName;
  if (typeof id !== "string" || id.length === 0) return null;
  // Blank, not just absent. `ProviderGlyph` falls back with `??`, which an
  // empty string passes straight through, leaving a `role="img"` element with
  // an empty `aria-label` — an image announced as having no name at all.
  if (typeof displayName !== "string" || displayName.trim().length === 0) {
    return null;
  }
  return { id, displayName, logoUrl: decodeLogoUrl(raw.logoUrl) };
}

/**
 * Stored providers, or null on a miss — same contract as the rows decode, and
 * the same length guard, which is the whole bound here: a provider list is a
 * handful of entries, so a count cap on top of it would only name a number
 * nothing approaches.
 */
export function decodeWarmStartProviders(stored: string | null): WarmStartProvider[] | null {
  if (stored === null) return null;
  if (stored.length > MAX_WARM_START_ENTRY_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const providers: WarmStartProvider[] = [];
  for (const entry of parsed) {
    const provider = decodeProvider(entry);
    if (provider === null) return null;
    providers.push(provider);
  }
  return providers;
}

/** Only the three fields the glyph reads, so an added host field is dropped. */
export function encodeWarmStartProviders(providers: readonly WarmStartProvider[]): string {
  return JSON.stringify(
    providers.map(({ id, displayName, logoUrl }) => ({
      id,
      displayName,
      logoUrl,
    })),
  );
}

export function readWarmStartProviders(
  storage: WarmStartStorage | null = defaultStorage(),
): WarmStartProvider[] | null {
  const stored = readEntry(WARM_START_PROVIDERS_KEY, storage);
  if (stored === null) return null;
  const providers = decodeWarmStartProviders(stored);
  if (providers === null) {
    forgetEntry(WARM_START_PROVIDERS_KEY, storage);
    return null;
  }
  return providers;
}

export function writeWarmStartProviders(
  providers: readonly WarmStartProvider[],
  storage: WarmStartStorage | null = defaultStorage(),
): void {
  writeEntry(WARM_START_PROVIDERS_KEY, encodeWarmStartProviders(providers), storage);
}
