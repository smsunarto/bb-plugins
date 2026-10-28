// Pure rules behind the choose-and-edit components (choose.tsx,
// EditableTable.tsx): option, colour, column and prompt shapes, picking from
// a list, editing rows, reading typed numbers. No React, no DOM.
import type { Scalar, Value } from "../../core/types";
import { isObject, isScalar, list, text } from "../values";

// ── OptionCards ──────────────────────────────────────────────────────────────

export interface CardOption {
  readonly value: Scalar;
  readonly title: string;
  readonly detail: string | null;
  readonly image: string | null;
  readonly icon: string | null;
}

/** A non-empty trimmed string field, else null. */
function field(value: unknown): string | null {
  const shown = text(value).trim();
  return shown === "" ? null : shown;
}

/**
 * OptionCards options: scalars, or `{value, title?, detail?, image?, icon?}`.
 * An object without a scalar `value` uses its title as the value; one with
 * neither is skipped (a streaming spec shows `{}` before its fields arrive).
 * Null when `options` is not a list.
 */
export function cardOptions(options: Value | undefined): CardOption[] | null {
  if (!Array.isArray(options)) return null;
  return list(options).flatMap((item): CardOption[] => {
    if (isScalar(item)) {
      if (item === null) return [];
      return [{ value: item, title: String(item), detail: null, image: null, icon: null }];
    }
    if (!isObject(item)) return [];
    // Read by key: narrowing kept the Action shapes, which name no options fields.
    const entry: Readonly<Record<string, unknown>> = item;
    const title = field(entry.title);
    const value = Object.hasOwn(entry, "value") && isScalar(entry.value) && entry.value !== null ? entry.value : title;
    if (value === null) return [];
    return [
      {
        value,
        title: title ?? String(value),
        detail: field(entry.detail),
        image: field(entry.image),
        icon: field(entry.icon),
      },
    ];
  });
}

/**
 * The list state after toggling `option`: unticking removes it, ticking adds
 * it in option order. Values the spec preset that are not options stay, after
 * the options.
 */
export function togglePick(picked: readonly Value[], option: Scalar, options: readonly Scalar[]): Value[] {
  if (picked.includes(option)) return picked.filter((value) => value !== option);
  return [
    ...options.filter((candidate, index) => (candidate === option || picked.includes(candidate)) && options.indexOf(candidate) === index),
    ...picked.filter((value) => !options.includes(value as Scalar)),
  ];
}

// ── Swatches ─────────────────────────────────────────────────────────────────

export interface Swatch {
  readonly value: string;
  readonly name: string | null;
}

/**
 * Swatches colours: CSS colour strings or `{value, name?}`. `isColor` decides
 * what counts (the renderer passes `CSS.supports("color", …)`); refused
 * entries are listed in `invalid`. `{}` and objects still missing their value
 * are skipped while a spec streams. Null when `colors` is not a list.
 */
export function swatchColors(
  colors: Value | undefined,
  isColor: (value: string) => boolean,
): { readonly colors: Swatch[]; readonly invalid: string[] } | null {
  if (!Array.isArray(colors)) return null;
  const valid: Swatch[] = [];
  const invalid: string[] = [];
  for (const item of list(colors)) {
    const entry: Readonly<Record<string, unknown>> = isObject(item) ? item : { value: item };
    if (entry.value === undefined || entry.value === null) continue;
    const value = typeof entry.value === "string" ? entry.value.trim() : "";
    if (value !== "" && isColor(value)) valid.push({ value, name: field(entry.name) });
    else invalid.push(text(entry.value) || JSON.stringify(entry.value));
  }
  return { colors: valid, invalid };
}

/** Colour strings compare without case or surrounding space: `#FFF` picks `#fff`. */
export function sameColor(a: Value, b: string): boolean {
  return typeof a === "string" && a.trim().toLowerCase() === b.toLowerCase();
}

// ── EditableTable ────────────────────────────────────────────────────────────

export type ColumnType = "text" | "number" | "boolean";

export interface TableColumn {
  readonly key: string;
  readonly label: string;
  readonly type: ColumnType;
}

export type TableRow = Readonly<Record<string, Value>>;

/** A key as a header: first letter capitalized (`price` → `Price`). */
export function columnLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** What a column without a `type` holds: the kind of its first filled cell, else text. */
function inferType(key: string, rows: readonly TableRow[]): ColumnType {
  for (const row of rows) {
    const cell = Object.hasOwn(row, key) ? row[key] : null;
    if (typeof cell === "number") return "number";
    if (typeof cell === "boolean") return "boolean";
    if (cell !== null) return "text";
  }
  return "text";
}

/**
 * EditableTable columns: keys, or `{key, label?, type?: text|number|boolean}`.
 * A column without a valid type takes the kind of its first filled cell.
 * Columns without a key (still streaming) and repeated keys are skipped.
 */
export function tableColumns(columns: Value | undefined, rows: readonly TableRow[]): TableColumn[] {
  const seen = new Set<string>();
  return list(columns).flatMap((item): TableColumn[] => {
    const entry: Readonly<Record<string, unknown>> = isObject(item) ? item : { key: item };
    const key = typeof entry.key === "string" || typeof entry.key === "number" ? String(entry.key).trim() : "";
    if (key === "" || seen.has(key)) return [];
    seen.add(key);
    const type = entry.type === "text" || entry.type === "number" || entry.type === "boolean" ? entry.type : inferType(key, rows);
    return [{ key, label: field(entry.label) ?? columnLabel(key), type }];
  });
}

/** The rows a list state holds; an empty state is no rows. Null when a row is not an object. */
export function tableRows(value: Value): TableRow[] | null {
  if (value === null) return [];
  if (!Array.isArray(value)) return null;
  const rows = list(value);
  return rows.every(isObject) ? (rows as TableRow[]) : null;
}

/** A new row: every column present, so the spec's `row.key` reads never miss. Numbers start empty (null). */
export function blankRow(columns: readonly TableColumn[]): TableRow {
  return Object.fromEntries(columns.map((column) => [column.key, column.type === "boolean" ? false : column.type === "number" ? null : ""]));
}

/** `rows` with one cell replaced; the row's other keys (shown or not) are kept. */
export function setCell(rows: readonly TableRow[], index: number, key: string, value: Value): TableRow[] {
  return rows.map((row, position) => (position === index ? { ...row, [key]: value } : row));
}

/**
 * A typed number: `12`, `-3.5`, `1,234.5` (comma grouping) or `3,5` (a
 * decimal comma, as decimal keyboards type in many locales). "" is null
 * (empty cell); anything unreadable, including a half-typed `-` or `1.`,
 * is undefined so the field keeps the draft without writing it.
 */
export function parseNumberInput(input: string): number | null | undefined {
  const compact = input.trim().replace(/[\s\u00a0\u202f']/g, "");
  if (compact === "") return null;
  const normalized = compact.includes(".")
    ? compact.replace(/,/g, "")
    : /^-?\d{1,3}(,\d{3})+$/.test(compact) && !/^-?0,/.test(compact)
      ? // 1,234 is grouping; 3,5 or 0,250 is a decimal comma.
        compact.replace(/,/g, "")
      : compact.replace(",", ".");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(normalized) || normalized.endsWith(".")) return undefined;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

// ── FollowUps ────────────────────────────────────────────────────────────────

/** FollowUps prompts: non-empty strings (numbers read as text), trimmed; repeats dropped. */
export function followUpPrompts(prompts: Value | undefined): string[] {
  const out: string[] = [];
  for (const item of list(prompts)) {
    if (typeof item !== "string" && typeof item !== "number") continue;
    const prompt = String(item).trim();
    if (prompt !== "" && !out.includes(prompt)) out.push(prompt);
  }
  return out;
}
