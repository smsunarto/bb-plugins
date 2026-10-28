// Pure chart arithmetic: stacking, pie slicing, rounding, scales and the
// geometry of the radial and grid charts. No DOM, so the numbers a chart
// draws are testable without rendering it.
import { formatNumber } from "../values";

/** One series' piece of a stacked column, in data units. */
export interface Segment {
  from: number;
  to: number;
  /** The outermost non-empty piece on its side of zero: the one with rounded corners. */
  outer: boolean;
}

/**
 * Diverging stack per label: positive values pile up from zero, negative ones
 * pile down from it, in series order. A missing value stays a gap (null) and
 * leaves the stack under the next series unchanged.
 */
export function stackSeries(series: readonly (readonly (number | null)[])[]): (Segment | null)[][] {
  const count = Math.max(0, ...series.map((values) => values.length));
  const stacked = series.map(() => Array.from<Segment | null>({ length: count }).fill(null));
  for (let index = 0; index < count; index++) {
    let up = 0;
    let down = 0;
    let lastUp: Segment | null = null;
    let lastDown: Segment | null = null;
    for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex++) {
      const value = series[seriesIndex]![index] ?? null;
      if (value === null || !Number.isFinite(value)) continue;
      const segment: Segment =
        value >= 0 ? { from: up, to: (up += value), outer: false } : { from: down, to: (down += value), outer: false };
      stacked[seriesIndex]![index] = segment;
      if (value > 0) lastUp = segment;
      if (value < 0) lastDown = segment;
    }
    if (lastUp !== null) lastUp.outer = true;
    if (lastDown !== null) lastDown.outer = true;
  }
  return stacked;
}

export interface Slice {
  label: string;
  value: number;
  /** Position in the source data; -1 for the folded "Other" slice. */
  source: number;
}

/**
 * Pie slices in data order. Only positive finite values count; past `max`
 * slices the largest `max - 1` stay and the rest fold into a trailing "Other".
 */
export function pieSlices(labels: readonly string[], values: readonly (number | null)[], max = 8): Slice[] {
  const slices = values.flatMap((value, source) =>
    value !== null && Number.isFinite(value) && value > 0
      ? [{ label: labels[source] || `Item ${source + 1}`, value, source }]
      : [],
  );
  if (slices.length <= max) return slices;
  const kept = new Set(
    [...slices]
      .sort((a, b) => b.value - a.value || a.source - b.source)
      .slice(0, Math.max(0, max - 1))
      .map((slice) => slice.source),
  );
  const other = slices.reduce((sum, slice) => (kept.has(slice.source) ? sum : sum + slice.value), 0);
  return [...slices.filter((slice) => kept.has(slice.source)), { label: "Other", value: other, source: -1 }];
}

/**
 * Whole percentages of the total that always add up to 100 (largest
 * remainder): the shares that lost the most to rounding down get the spare points.
 */
export function percentages(values: readonly number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0) || !Number.isFinite(total)) return values.map(() => 0);
  const exact = values.map((value) => (value / total) * 100);
  const whole = exact.map(Math.floor);
  const spare = 100 - whole.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((share, index) => ({ index, remainder: share - whole[index]! }))
    .sort((a, b) => b.remainder - a.remainder || values[b.index]! - values[a.index]! || a.index - b.index);
  for (let k = 0; k < spare; k++) whole[order[k % order.length]!.index]! += 1;
  return whole;
}

/** "Trend from 12 to 18, up 50%": what a sparkline shows, for screen readers. */
export function trendLabel(values: readonly number[]): string {
  if (values.length < 2) return "No trend";
  const first = values[0]!;
  const last = values[values.length - 1]!;
  const base = `Trend from ${formatNumber(first)} to ${formatNumber(last)}`;
  if (first === last) return `${base}, flat`;
  const direction = last > first ? "up" : "down";
  if (first === 0) return `${base}, ${direction}`;
  return `${base}, ${direction} ${formatNumber(Math.round(Math.abs((last - first) / first) * 100))}%`;
}

/** 1, 2, 2.5 or 5 × 10^k nearest above `value` (> 0): a step people can read. */
export function niceStep(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 2.5, 5]) {
    if (factor * magnitude >= value) return factor * magnitude;
  }
  return 10 * magnitude;
}

/** An axis: readable bounds and the ticks between them, both ends included. */
export interface Scale {
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly number[];
}

/**
 * A scale covering `low`..`high` in about `count` readable steps. `zero`
 * keeps zero in range (bars, radii); a single value gets one step around it.
 */
export function niceScale(low: number, high: number, count = 4, zero = false): Scale {
  const from = zero ? Math.min(low, 0) : low;
  const to = zero ? Math.max(high, 0) : high;
  const step = niceStep((to - from || Math.abs(to) || 1) / count);
  const min = Math.floor(from / step) * step;
  let max = Math.ceil(to / step) * step;
  if (max === min) max = min + step;
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) =>
    // Rounded, so 0.1-steps read 0.3 rather than 0.30000000000000004.
    Number((min + i * step).toPrecision(12)),
  );
  return { min: ticks[0]!, max: ticks[ticks.length - 1]!, ticks };
}

/** A count axis from zero to at least `max` in about four whole-number steps (never 2.5). */
export function countTicks(max: number): number[] {
  const nice = niceStep(Math.max(1, max) / 4);
  const step = Math.max(1, Number.isInteger(nice) ? nice : Math.floor(nice));
  const top = Math.max(step, Math.ceil(max / step) * step);
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

/** A number, or a string that is exactly one (`"2.5"`, `" 10 "`); else null. Scatter x values. */
export function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : null;
}

/** A ratio as a readable percentage: whole from 10%, one decimal below, `<0.1%` for slivers. */
export function formatShare(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  const percent = ratio * 100;
  if (percent === 0) return "0%";
  if (Math.abs(percent) < 0.1) return "<0.1%";
  return `${formatNumber(Number(percent.toFixed(Math.abs(percent) < 10 ? 1 : 0)))}%`;
}

export interface ScatterPoint {
  /** Position of its series. */
  readonly series: number;
  /** Position in `labels` (and in its series' values). */
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

/** Every pair with both an x and a y, ordered by x, then series: the order keys step through. */
export function scatterPoints(
  xs: readonly (number | null)[],
  series: readonly (readonly (number | null)[])[],
): ScatterPoint[] {
  const points: ScatterPoint[] = [];
  series.forEach((values, seriesIndex) => {
    xs.forEach((x, index) => {
      const y = values[index] ?? null;
      if (x !== null && y !== null && Number.isFinite(x) && Number.isFinite(y)) {
        points.push({ series: seriesIndex, index, x, y });
      }
    });
  });
  return points.sort((a, b) => a.x - b.x || a.series - b.series || a.index - b.index);
}

/** The point closest to (`x`, `y`) within `radius`, or null when none is that close. */
export function nearestPoint(
  points: readonly (readonly [number, number])[],
  x: number,
  y: number,
  radius: number,
): number | null {
  let best: number | null = null;
  let bestDistance = radius * radius;
  points.forEach(([px, py], index) => {
    const distance = (px - x) ** 2 + (py - y) ** 2;
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** Where `ratio` (0 centre, 1 rim) lies on spoke `axis` of `count`: the first straight up, then clockwise. */
export function radarPoint(
  cx: number,
  cy: number,
  radius: number,
  axis: number,
  count: number,
  ratio: number,
): readonly [number, number] {
  const angle = (axis / count) * Math.PI * 2;
  return [cx + radius * ratio * Math.sin(angle), cy - radius * ratio * Math.cos(angle)];
}

export interface FunnelStage {
  readonly label: string;
  readonly value: number;
  /** Bar width as a share of the widest stage, 0 to 1. */
  readonly width: number;
  /** value / first stage's value; null when the first is not positive. */
  readonly ofFirst: number | null;
  /** value / previous stage's value; null for the first stage or after a non-positive one. */
  readonly ofPrevious: number | null;
}

/** Stages with a number, in order; a stage whose value has not arrived yet is left out. */
export function funnelStages(labels: readonly string[], values: readonly (number | null)[]): FunnelStage[] {
  const present = values.flatMap((value, index) =>
    value !== null && Number.isFinite(value) ? [{ label: labels[index] || `Stage ${index + 1}`, value }] : [],
  );
  const widest = Math.max(0, ...present.map((stage) => stage.value));
  const first = present[0]?.value ?? 0;
  return present.map((stage, index) => {
    const previous = index === 0 ? 0 : present[index - 1]!.value;
    return {
      ...stage,
      width: widest > 0 ? Math.max(0, stage.value) / widest : 0,
      ofFirst: first > 0 ? stage.value / first : null,
      ofPrevious: index > 0 && previous > 0 ? stage.value / previous : null,
    };
  });
}

/** Lowest and highest finite value, or null when there is none. */
export function valueRange(values: readonly (number | null)[]): { min: number; max: number } | null {
  const numbers = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return numbers.length === 0 ? null : { min: Math.min(...numbers), max: Math.max(...numbers) };
}

/** Where `value` sits between `min` and `max`, 0 to 1; a flat range reads as full. */
export function intensity(value: number, min: number, max: number): number {
  if (!(max > min)) return 1;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** A count's shade, GitHub-style: 0 for nothing (zero or below), else 1..`levels` by its share of `max`. */
export function heatLevel(value: number, max: number, levels = 4): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(levels, Math.max(1, Math.ceil((value / max) * levels)));
}

/** A point on the upper half circle: ratio 0 at the left end, 1 at the right, through the top. */
export function dialPoint(cx: number, cy: number, radius: number, ratio: number): readonly [number, number] {
  const angle = Math.PI * (1 - ratio);
  return [cx + radius * Math.cos(angle), cy - radius * Math.sin(angle)];
}

/**
 * The cell an arrow key moves to in a `rows` × `cols` grid (Home/End: the
 * row's ends), clamped at the edges; null for any other key.
 */
export function stepGrid(
  key: string,
  row: number,
  col: number,
  rows: number,
  cols: number,
): readonly [number, number] | null {
  const clamp = (value: number, size: number) => Math.min(size - 1, Math.max(0, value));
  switch (key) {
    case "ArrowLeft":
      return [row, clamp(col - 1, cols)];
    case "ArrowRight":
      return [row, clamp(col + 1, cols)];
    case "ArrowUp":
      return [clamp(row - 1, rows), col];
    case "ArrowDown":
      return [clamp(row + 1, rows), col];
    case "Home":
      return [row, 0];
    case "End":
      return [row, cols - 1];
    default:
      return null;
  }
}
