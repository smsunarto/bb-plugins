// Compare's input as both the renderer and the markdown fallback read it: the
// images (the first is the reference), their labels and capture conditions,
// which conditions differ between two of them, and how a candidate of another
// size is fitted onto the reference. Pure.
import { isPlainObject } from "./evaluate";
import type { Value } from "./types";

export interface CompareImage {
  readonly src: string;
  /** What the user calls it: the given label, else "Reference" for the first and the file name for the others. */
  readonly label: string;
  /** True when `label` was given rather than derived. */
  readonly named: boolean;
  readonly note: string | null;
  /** Capture facts in the order given (build, viewport, device, theme, time…), values as text. */
  readonly meta: readonly (readonly [key: string, value: string])[];
}

export type CompareRead =
  | { readonly ok: true; readonly images: readonly CompareImage[]; readonly ignored: number }
  | { readonly ok: false; readonly error: string };

const LABEL_KEYS = ["label", "name", "title", "caption", "alt"] as const;
const SRC_KEYS = ["src", "path", "url", "image"] as const;
/** Entry keys that are not capture facts; any other scalar key on an entry joins its meta. */
const ENTRY_KEYS: Record<string, true> = {
  src: true,
  path: true,
  url: true,
  image: true,
  note: true,
  detail: true,
  meta: true,
  label: true,
  name: true,
  title: true,
  caption: true,
  alt: true,
};

/**
 * Facts that are expected to differ between a reference and what is compared
 * with it (they say which build or capture each one is), so they never make
 * the comparison "not the same conditions". Everything else (theme, viewport,
 * device, browser, scale, time, state…) is a condition. Keys as `metaKey` writes them.
 */
const IDENTITY_KEYS: Record<string, true> = {
  build: true,
  commit: true,
  sha: true,
  revision: true,
  rev: true,
  branch: true,
  version: true,
  tag: true,
  pr: true,
  run: true,
  captured: true,
  capturedat: true,
  date: true,
  timestamp: true,
  source: true,
  url: true,
  path: true,
  file: true,
};

function scalarText(value: Value | undefined): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return null;
}

/** The last path segment of a src (query and fragment dropped), or the src itself. */
export function fileName(src: string): string {
  const path = src.replace(/[?#].*$/, "");
  const name = path.split(/[\\/]/).filter((part) => part !== "").pop();
  try {
    return name === undefined ? src : decodeURIComponent(name);
  } catch {
    return name ?? src;
  }
}

function readMeta(entry: Readonly<Record<string, Value>>): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  const add = (key: string, value: Value | undefined) => {
    const text = scalarText(value);
    const id = metaKey(key);
    if (text === null || id === "" || seen.has(id)) return;
    seen.add(id);
    out.push([key.trim(), text]);
  };
  if (entry.meta !== undefined && isPlainObject(entry.meta)) for (const [key, value] of Object.entries(entry.meta)) add(key, value);
  for (const [key, value] of Object.entries(entry)) if (!Object.hasOwn(ENTRY_KEYS, key)) add(key, value);
  return out;
}

/**
 * `images`: a list of a src string or `{src, label?, note?, meta?}` (scalar
 * keys beside src such as `theme: "dark"` count as meta). Entries without a
 * src are counted in `ignored`; the list must name at least one image.
 */
export function readCompare(value: Value | undefined): CompareRead {
  if (!Array.isArray(value)) return { ok: false, error: "Compare needs a list of images: the reference first, then what to compare with it" };
  const images: CompareImage[] = [];
  let ignored = 0;
  for (const item of value as readonly Value[]) {
    const entry: Readonly<Record<string, Value>> | null = isPlainObject(item) ? item : null;
    const raw = entry === null ? item : SRC_KEYS.map((key) => entry[key]).find((field) => typeof field === "string" && field.trim() !== "");
    if (typeof raw !== "string" || raw.trim() === "") {
      ignored++;
      continue;
    }
    const src = raw.trim();
    const given = entry === null ? null : (LABEL_KEYS.map((key) => scalarText(entry[key])).find((label) => label !== null) ?? null);
    images.push({
      src,
      label: given ?? (images.length === 0 ? "Reference" : fileName(src)),
      named: given !== null,
      note: entry === null ? null : scalarText(entry.note ?? entry.detail),
      meta: entry === null ? [] : readMeta(entry),
    });
  }
  return { ok: true, images, ignored };
}

/** A meta key compared without case, spaces, dashes or underscores: `capturedAt` = `captured_at`. */
export function metaKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]+/g, "");
}

/** A meta value compared without case or spacing; `1440x900` = `1440 × 900`. */
function metaValue(value: string): string {
  return value.toLowerCase().replace(/\s*[×x]\s*/g, "x").replace(/\s+/g, " ").trim();
}

export function isConditionKey(key: string): boolean {
  return !Object.hasOwn(IDENTITY_KEYS, metaKey(key));
}

export interface ConditionDifference {
  /** The key as the reference names it (else as the candidate does). */
  readonly key: string;
  /** Null where that image does not state it. */
  readonly reference: string | null;
  readonly candidate: string | null;
}

/**
 * The capture conditions that differ between the reference and a candidate:
 * stated on both with different values, or stated on one only (unknown is
 * not the same). Identity facts (build, commit, capture date…) are left out.
 */
export function conditionDifferences(reference: CompareImage, candidate: CompareImage): ConditionDifference[] {
  const theirs = new Map(candidate.meta.map(([key, value]) => [metaKey(key), { key, value }]));
  const out: ConditionDifference[] = [];
  for (const [key, value] of reference.meta) {
    if (!isConditionKey(key)) continue;
    const other = theirs.get(metaKey(key));
    theirs.delete(metaKey(key));
    if (other === undefined) out.push({ key, reference: value, candidate: null });
    else if (metaValue(other.value) !== metaValue(value)) out.push({ key, reference: value, candidate: other.value });
  }
  for (const { key, value } of theirs.values()) if (isConditionKey(key)) out.push({ key, reference: null, candidate: value });
  return out;
}

/** "theme light vs dark", "device stated only for Reference (iPhone 15)". */
export function differenceText(difference: ConditionDifference, referenceLabel: string, candidateLabel: string): string {
  const { key, reference, candidate } = difference;
  if (reference !== null && candidate !== null) return `${key} ${reference} vs ${candidate}`;
  return reference !== null ? `${key} stated only for ${referenceLabel} (${reference})` : `${key} stated only for ${candidateLabel} (${candidate ?? ""})`;
}

/** "Not the same conditions: theme light vs dark · viewport 1440 vs 390"; null when nothing differs. */
export function conditionsWarning(differences: readonly ConditionDifference[], referenceLabel: string, candidateLabel: string): string | null {
  if (differences.length === 0) return null;
  return `Not the same conditions: ${differences.map((difference) => differenceText(difference, referenceLabel, candidateLabel)).join(" · ")}`;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * Where a candidate lands on the reference's pixel grid: scaled to the
 * reference's width (keeping its own aspect, so nothing is stretched) and
 * top-aligned, as screenshots of one page line up. `height` may be shorter or
 * taller than the reference; the part it misses counts as changed.
 */
export interface Placement {
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly sameSize: boolean;
  readonly sameAspect: boolean;
}

export function placement(reference: Size, candidate: Size): Placement {
  const scale = candidate.width > 0 ? reference.width / candidate.width : 1;
  const height = candidate.height * scale;
  const sameSize = reference.width === candidate.width && reference.height === candidate.height;
  // Within a pixel of the reference height after scaling: rounding, not a different aspect.
  const sameAspect = Math.abs(height - reference.height) <= 1;
  return { scale, width: reference.width, height: sameAspect ? reference.height : height, sameSize, sameAspect };
}

/**
 * "Sizes differ: 1440×900 vs 1280×800, scaled ×1.13 to the reference"; with
 * another aspect also how the heights compare. Null when the sizes match.
 */
export function sizeWarning(reference: Size, candidate: Size, candidateLabel: string): string | null {
  const fit = placement(reference, candidate);
  if (fit.sameSize) return null;
  const sizes = `Sizes differ: ${reference.width}×${reference.height} vs ${candidate.width}×${candidate.height}`;
  const factor = `×${Number(fit.scale.toPrecision(3))}`;
  if (fit.sameAspect) return `${sizes}, ${candidateLabel} scaled ${factor} to the reference`;
  const scaled = fit.scale === 1 ? "" : ` scaled ${factor} to the reference width,`;
  const rows = Math.round(Math.abs(fit.height - reference.height));
  return `${sizes};${scaled} top-aligned, ${candidateLabel} is ${rows} px ${fit.height < reference.height ? "shorter (the rest counts as changed)" : "taller (cut at the reference height)"}`;
}
