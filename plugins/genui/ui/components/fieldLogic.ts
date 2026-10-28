// Pure rules behind the input fields in fields.tsx: stepping without float
// drift, option and list shapes, dates and ratings. No React, no DOM.
import type { Scalar, Value } from "../../core/types";
import { finiteNumber, isObject, isScalar, list, optionalText } from "../values";

/** Decimal places a number is written with: 0.25 → 2, 1e-7 → 7, 3 → 0. */
export function decimals(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const [mantissa = "", exponent = "0"] = String(value).split("e");
  const fraction = mantissa.split(".")[1]?.length ?? 0;
  return Math.max(0, fraction - Number(exponent));
}

/** Digits kept after a step; enough for any sane step, few enough to drop float noise. */
const MAX_DECIMALS = 10;

export interface StepRange {
  readonly min: number | null;
  readonly max: number | null;
  /** Always positive. */
  readonly step: number;
}

/** Normalizes Stepper params: a missing or non-positive step is 1; max never sits below min. */
export function stepRange(min: Value | undefined, max: Value | undefined, step: Value | undefined): StepRange {
  const low = finiteNumber(min);
  const high = finiteNumber(max);
  const size = finiteNumber(step);
  return {
    min: low,
    max: high === null || low === null ? high : Math.max(low, high),
    step: size !== null && size > 0 ? size : 1,
  };
}

export function clampToRange(value: number, range: StepRange): number {
  const floor = range.min ?? -Infinity;
  const ceiling = range.max ?? Infinity;
  return Math.min(ceiling, Math.max(floor, value));
}

/** The precision a stepped value is shown and stored with. */
export function stepPrecision(value: number, range: StepRange): number {
  return Math.min(
    MAX_DECIMALS,
    Math.max(decimals(range.step), decimals(range.min ?? 0), decimals(range.max ?? 0), decimals(value)),
  );
}

/**
 * `value` moved by `count` steps (negative steps down), rounded so 0.1 + 0.2
 * lands on 0.3, then clamped. `±Infinity` jumps to a bound; with no such
 * bound the value stays.
 */
export function stepBy(value: number, count: number, range: StepRange): number {
  const moved = clampToRange(Number((value + count * range.step).toFixed(stepPrecision(value, range))), range);
  return Number.isFinite(moved) ? moved : value;
}

/** What the Stepper shows and steps from: the bound state, else min, else 0, inside the range. */
export function stepperValue(state: Value | undefined, range: StepRange): number {
  return clampToRange(finiteNumber(state) ?? range.min ?? 0, range);
}

export interface RadioOption {
  readonly value: Scalar;
  readonly detail: string | null;
}

/** Radio options: scalars, or `{value, detail?}` objects with a scalar value; anything else is dropped. */
export function radioOptions(options: Value | undefined): RadioOption[] {
  return list(options).flatMap((option: unknown): RadioOption[] => {
    if (isScalar(option)) return [{ value: option, detail: null }];
    if (!isObject(option) || !isScalar(option.value)) return [];
    const detail = isScalar(option.detail) ? optionalText(option.detail) : null;
    return [{ value: option.value, detail: detail === "" ? null : detail }];
  });
}

/** How a list entry or option value reads on screen. */
export function itemText(value: Value): string {
  if (value === null) return "None";
  return isScalar(value) ? String(value) : JSON.stringify(value);
}

export type ItemProblem = "empty" | "duplicate";

/** Why `draft` cannot join `items` (ignoring the entry at `except`, the one being edited), or null if it can. */
export function itemProblem(items: readonly Value[], draft: string, except = -1): ItemProblem | null {
  const item = draft.trim();
  if (item === "") return "empty";
  return items.some((existing, index) => index !== except && itemText(existing) === item) ? "duplicate" : null;
}

/** `items` with the trimmed draft appended, or null when it is empty or already listed. */
export function addItem(items: readonly Value[], draft: string): Value[] | null {
  return itemProblem(items, draft) === null ? [...items, draft.trim()] : null;
}

/** `items` with entry `index` replaced by the trimmed draft; null when invalid or unchanged. */
export function replaceItem(items: readonly Value[], index: number, draft: string): Value[] | null {
  if (index < 0 || index >= items.length || itemProblem(items, draft, index) !== null) return null;
  const item = draft.trim();
  if (items[index] === item) return null;
  return items.map((existing, position) => (position === index ? item : existing));
}

/** A real calendar date in `yyyy-mm-dd`, else null (what a native date input accepts). */
export function isoDate(value: Value | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? value
    : null;
}

export const RATING_MAX_DEFAULT = 5;
const RATING_MAX_LIMIT = 10;

/** Star count: a whole number from 1 to 10, default 5. */
export function ratingMax(max: Value | undefined): number {
  const count = finiteNumber(max);
  if (count === null) return RATING_MAX_DEFAULT;
  return Math.min(RATING_MAX_LIMIT, Math.max(1, Math.round(count)));
}

/** The rating shown: the state inside 0..max (fractions kept, drawn as partial stars). */
export function ratingValue(state: Value | undefined, max: number): number {
  return Math.min(max, Math.max(0, finiteNumber(state) ?? 0));
}

/** How much of star `index` (1-based) is filled at `value`: 0 to 1. */
export function starFill(value: number, index: number): number {
  return Math.min(1, Math.max(0, value - (index - 1)));
}
