// What a ```app frame may tell the host (the bootstrap in ui/appDocument.ts
// posts these), checked strictly: the frame runs the model's code, so any
// message could be forged and only exact shapes count. Also where an app's
// localStorage is saved in the host's own localStorage.
import { APP_STORAGE_CAP, MAX_ANSWER_LENGTH, MAX_URL_LENGTH } from "./appDocument";

/** A browser API the sandbox can't offer, a link that can't open, or a bridge call made outside a click or key press. */
export type BlockedCall = "alert" | "confirm" | "prompt" | "open" | "link" | "answer" | "openLink";

const BLOCKED_CALLS: readonly BlockedCall[] = ["alert", "confirm", "prompt", "open", "link", "answer", "openLink"];

export type AppStorageItems = Readonly<Record<string, string>>;

export type AppMessage =
  | { readonly type: "height"; readonly height: number }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "storage"; readonly items: AppStorageItems }
  | { readonly type: "blocked"; readonly call: BlockedCall }
  | { readonly type: "answer"; readonly text: string | null }
  | { readonly type: "openLink"; readonly url: string }
  | { readonly type: "escape" };

/** An app's localStorage size as the frame counts it: every key and value, in UTF-16 units. */
export function storageSize(items: AppStorageItems): number {
  let size = 0;
  for (const [key, value] of Object.entries(items)) size += key.length + value.length;
  return size;
}

/** `value` as storage items: a plain object of strings within the cap; null for anything else. */
export function parseStorageItems(value: unknown): AppStorageItems | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) return null;
  // fromEntries defines own properties, so a `__proto__` key stays data.
  const items = Object.fromEntries(entries);
  return storageSize(items) <= APP_STORAGE_CAP ? items : null;
}

/** Accepts only `{ source: "genui-app", type, ...fields }` with exactly the type's fields. */
export function parseAppMessage(data: unknown): AppMessage | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.source !== "genui-app") return null;
  const keys = Object.keys(record).length;
  if (record.type === "escape") return keys === 2 ? { type: "escape" } : null;
  if (keys !== 3) return null;
  switch (record.type) {
    case "height": {
      const { height } = record;
      return typeof height === "number" && Number.isFinite(height) && height >= 0 ? { type: "height", height } : null;
    }
    case "error": {
      const { message } = record;
      return typeof message === "string" ? { type: "error", message: message.slice(0, 500) } : null;
    }
    case "storage": {
      const items = parseStorageItems(record.items);
      return items === null ? null : { type: "storage", items };
    }
    case "blocked": {
      const call = BLOCKED_CALLS.find((name) => name === record.what);
      return call === undefined ? null : { type: "blocked", call };
    }
    case "answer": {
      const { text } = record;
      if (text === null) return { type: "answer", text: null };
      if (typeof text !== "string") return null;
      const answer = text.trim().slice(0, MAX_ANSWER_LENGTH).trim();
      return { type: "answer", text: answer === "" ? null : answer };
    }
    case "openLink": {
      const { url } = record;
      if (typeof url !== "string" || url.length > MAX_URL_LENGTH) return null;
      let link: URL;
      try {
        link = new URL(url);
      } catch {
        return null;
      }
      return link.protocol === "https:" ? { type: "openLink", url: link.href } : null;
    }
    default:
      return null;
  }
}

/** The note under an app that made a blocked call. */
export function blockedNote(call: BlockedCall): string {
  switch (call) {
    case "alert":
    case "confirm":
    case "prompt":
      return `This app called ${call}(), which apps can't show: it should draw that in its page.`;
    case "open":
      return "This app called window.open(), which apps can't use: links go through genui.openLink.";
    case "link":
      return "Only https links open from an app (in BB); this one goes nowhere.";
    case "answer":
    case "openLink":
      return `genui.${call}() works only from a click or key press in the app.`;
  }
}

/** Index of saved app storage, oldest write first: `[stateKey, size]`. */
const INDEX_KEY = "bb.genui.appStorage";
/** What every app's saved storage together may take of the host's localStorage (BB's own lives there too). */
export const APPS_STORAGE_BUDGET = 1024 * 1024;

const itemKey = (stateKey: string) => `${stateKey}:storage`;

/** The index, without malformed entries; a damaged copy is an empty one. */
function readIndex(): Array<[string, number]> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]");
  } catch {
    // Damaged: start over.
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is [string, number] =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "number",
  );
}

/** The storage app `stateKey` saved, from the host's localStorage; empty when none (or damaged). */
export function readAppStorage(stateKey: string): AppStorageItems {
  try {
    return parseStorageItems(JSON.parse(localStorage.getItem(itemKey(stateKey)) ?? "{}")) ?? {};
  } catch {
    return {};
  }
}

/**
 * Saves app `stateKey`'s storage. Over the budget, the apps written longest
 * ago lose theirs first; the app saving now always keeps its own.
 */
export function saveAppStorage(stateKey: string, items: AppStorageItems): void {
  try {
    const size = storageSize(items);
    const index = readIndex().filter(([key]) => key !== stateKey);
    if (size > 0) index.push([stateKey, size]);
    let total = index.reduce((sum, [, entry]) => sum + entry, 0);
    while (total > APPS_STORAGE_BUDGET && index.length > 1) {
      const [evicted, evictedSize] = index.shift()!;
      localStorage.removeItem(itemKey(evicted));
      total -= evictedSize;
    }
    if (size > 0) localStorage.setItem(itemKey(stateKey), JSON.stringify(items));
    else localStorage.removeItem(itemKey(stateKey));
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Host storage full, damaged or unavailable: the app keeps its storage while on screen.
  }
}
