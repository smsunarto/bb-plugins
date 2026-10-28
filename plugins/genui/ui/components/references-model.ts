// Pure readers behind the reference renderers (references.tsx): Entity,
// Sources and Hotspots. They turn the loose shapes models write into exactly
// what the components draw, and report what they cannot read instead of
// throwing. A list that is still streaming ends in a half-written item; the
// readers skip that last item quietly rather than flash an error for it.
import type { Value } from "../../core/types";
import { isNode, isObject, text } from "../values";
import type { KeyValuePair } from "./content-model";

// ---------------------------------------------------------------------------
// URLs and images

/** An absolute URL with one of `schemes` (lowercase, without `:`), or null. */
export function parseUrl(raw: string, schemes: readonly string[]): URL | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  return schemes.includes(url.protocol.slice(0, -1)) && url.hostname !== "" ? url : null;
}

/** The host a reader recognizes: `www.` dropped, port kept. */
export function domainOf(url: URL): string {
  return url.host.replace(/^www\./i, "");
}

/** The readable part of a URL after its host (`/docs/intro` → `docs/intro`), or null for a bare host. */
export function pathOf(url: URL): string | null {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }
  path = path.replace(/^\/+|\/+$/g, "");
  return path === "" ? null : path;
}

/** What an image `src` names: an https URL or a thread file, both loaded through the runtime; or a refusal. */
export type ImageRef =
  | { readonly kind: "none" }
  | { readonly kind: "load"; readonly src: string }
  | { readonly kind: "invalid"; readonly error: string };

export function imageRef(src: string): ImageRef {
  const trimmed = src.trim();
  if (trimmed === "") return { kind: "none" };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  // `C:\…` is a Windows path, not a URL scheme.
  if (scheme === undefined || /^[a-z]:[\\/]/i.test(trimmed)) return { kind: "load", src: trimmed };
  if (scheme !== "https") {
    return { kind: "invalid", error: `Images must be https URLs or file paths; ${scheme}: links can't be shown` };
  }
  const url = parseUrl(trimmed, ["https"]);
  return url === null ? { kind: "invalid", error: `Invalid image URL: ${trimmed}` } : { kind: "load", src: url.href };
}

// ---------------------------------------------------------------------------
// Entity

export const ENTITY_KINDS = ["product", "place", "person", "org", "link", "other"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export function entityKind(value: unknown): EntityKind {
  return typeof value === "string" && (ENTITY_KINDS as readonly string[]).includes(value)
    ? (value as EntityKind)
    : "other";
}

/** The facts worth showing on the card itself: the first `max` with a plain, non-empty value. */
export function inlineFacts(
  pairs: readonly KeyValuePair[],
  max: number,
): { readonly label: string; readonly value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const [label, value] of pairs) {
    if (out.length >= max) break;
    const shown = typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
    if (shown !== "") out.push({ label: label.trim(), value: shown });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sources

export type SourceLink =
  | {
      readonly ok: true;
      /** 1-based position in the list as written, so `[2]` in prose names the second link. */
      readonly number: number;
      readonly href: string;
      /** The given title, else the domain. */
      readonly title: string;
      readonly domain: string;
      /** The path, shown when there is no title to say what the page is. */
      readonly path: string | null;
      readonly note: string | null;
    }
  | { readonly ok: false; readonly number: number; readonly error: string };

/** `https://…` strings or `{url, title?, note?}` objects; anything else keeps its number and reports why. */
export function sourceLinks(items: readonly Value[]): SourceLink[] {
  const out: SourceLink[] = [];
  items.forEach((item, index) => {
    const number = index + 1;
    const last = index === items.length - 1;
    const fields: Readonly<Record<string, unknown>> | null =
      typeof item === "string" ? { url: item } : isObject(item) && !isNode(item) ? item : null;
    if (fields === null) {
      out.push({ ok: false, number, error: "Each source must be an https URL or {url, title?, note?}" });
      return;
    }
    // A streaming `{title: "…"` has not reached its url yet.
    if (fields.url === undefined && last) return;
    const raw = text(fields.url).trim();
    const url = parseUrl(raw, ["https"]);
    if (url === null) {
      out.push({
        ok: false,
        number,
        error: raw === "" ? "This source has no url" : `Not an https link: ${raw}`,
      });
      return;
    }
    const title = text(fields.title).trim();
    const note = text(fields.note).trim();
    out.push({
      ok: true,
      number,
      href: url.href,
      title: title === "" ? domainOf(url) : title,
      domain: domainOf(url),
      path: title === "" ? pathOf(url) : null,
      note: note === "" ? null : note,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Hotspots

export interface HotspotPoint {
  /** 1-based, shared by the pin and its row in the list. */
  readonly number: number;
  /** Percent across the image, 0–100. */
  readonly x: number;
  /** Percent down the image, 0–100. */
  readonly y: number;
  readonly title: string;
  readonly text: string | null;
}

/** A percentage: a number, or a string such as `"40"` or `"40%"`; clamped to 0–100. */
export function percent(value: unknown): number | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*%?\s*$/.test(value)
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : null;
}

/**
 * `{x, y, title, text?}` points, numbered in order. A point without a
 * usable x/y is reported (its number goes to the next good point); the last
 * point is skipped quietly while it lacks x, y or title, because a
 * streaming list ends in one that is still being written.
 */
export function hotspotPoints(items: readonly Value[]): {
  readonly points: HotspotPoint[];
  readonly problems: string[];
} {
  const points: HotspotPoint[] = [];
  const problems: string[] = [];
  items.forEach((item: unknown, index) => {
    const last = index === items.length - 1;
    if (!isObject(item) || isNode(item)) {
      problems.push(`Point ${index + 1} must be {x, y, title, text?}`);
      return;
    }
    const x = percent(item.x);
    const y = percent(item.y);
    const title = text(item.title).trim();
    if (last && (x === null || y === null || title === "")) return;
    if (x === null || y === null) {
      problems.push(`Point ${index + 1}${title === "" ? "" : ` (${title})`} needs x and y in % (0–100)`);
      return;
    }
    const body = text(item.text).trim();
    const number = points.length + 1;
    points.push({ number, x, y, title: title === "" ? `Point ${number}` : title, text: body === "" ? null : body });
  });
  return { points, problems };
}
