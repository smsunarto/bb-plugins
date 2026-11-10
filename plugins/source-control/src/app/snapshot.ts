/**
 * The last row each thread's tab drew, kept in localStorage so the tab paints
 * at once on the next visit while the read is still on its way. Versioned,
 * size- and age-capped; anything unreadable is dropped, never trusted.
 */
import { threadChangeSchema, type ThreadChange } from "../core/change.ts";

const KEY = "source-control:snapshot:v1";
const MAX_ENTRIES = 40;
const MAX_BYTES = 200_000;
const MAX_AGE_MS = 14 * 24 * 60 * 60_000;

type Entry = { row: ThreadChange; savedAt: number };

function load(): Record<string, Entry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Entry>) : {};
  } catch {
    return {};
  }
}

export function readSnapshot(threadId: string, now = Date.now()): ThreadChange | undefined {
  const entry = load()[threadId];
  if (!entry || now - entry.savedAt > MAX_AGE_MS) return undefined;
  const parsed = threadChangeSchema.safeParse(entry.row);
  return parsed.success && parsed.data.state !== "pending" ? parsed.data : undefined;
}

export function writeSnapshot(threadId: string, row: ThreadChange, now = Date.now()): void {
  if (row.state === "pending") return;
  const entries = Object.entries({ ...load(), [threadId]: { row, savedAt: now } })
    .filter(([, entry]) => now - entry.savedAt <= MAX_AGE_MS)
    .toSorted(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, MAX_ENTRIES);
  // Drop the oldest until it fits.
  while (entries.length > 0) {
    const text = JSON.stringify(Object.fromEntries(entries));
    if (text.length <= MAX_BYTES) {
      try {
        localStorage.setItem(KEY, text);
      } catch {
        // Storage full or unavailable: the snapshot is only a head start.
      }
      return;
    }
    entries.pop();
  }
}
