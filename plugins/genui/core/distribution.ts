// The statistics behind the Chart types for raw observations (latencies,
// benchmark runs, scores): `histogram` counts them into bins, `box` sums each
// group up in five numbers. Shared by the renderer and the markdown form, so
// a phone reads the same bins and quartiles the chart draws.
import { niceStep } from "./perf-units";

/** One group of observations: its finite values, ascending, and how many entries were not numbers. */
export interface Sample {
  readonly name: string;
  readonly values: readonly number[];
  /** Empty (null) or non-finite entries, left out. */
  readonly dropped: number;
}

export function readSample(name: string, values: readonly unknown[]): Sample {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return { name, values: finite.sort((a, b) => a - b), dropped: values.length - finite.length };
}

/** Rounded, so arithmetic noise (0.30000000000000004) never reaches the screen. */
function clean(value: number): number {
  return Number(value.toPrecision(12));
}

/**
 * The `p` quantile (0..1) of ascending values by linear interpolation between
 * the closest ranks: Hyndman & Fan type 7, the default of R, NumPy and
 * Excel's QUARTILE.INC. Needs at least one value.
 */
export function quantile(sorted: readonly number[], p: number): number {
  const at = (sorted.length - 1) * p;
  const low = Math.floor(at);
  const high = Math.min(sorted.length - 1, low + 1);
  return clean(sorted[low]! + (at - low) * (sorted[high]! - sorted[low]!));
}

export interface BoxSummary {
  readonly n: number;
  readonly min: number;
  readonly q1: number;
  readonly median: number;
  readonly q3: number;
  readonly max: number;
  /** Whisker ends: the furthest values within 1.5 IQR of the box. */
  readonly low: number;
  readonly high: number;
  /** Values beyond the whiskers, ascending. */
  readonly outliers: readonly number[];
}

/** Tukey's box: quartiles (type 7), whiskers at 1.5 IQR, the rest outliers; null without values. */
export function boxSummary(sorted: readonly number[]): BoxSummary | null {
  if (sorted.length === 0) return null;
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const reach = 1.5 * (q3 - q1);
  const inside = sorted.filter((value) => value >= q1 - reach && value <= q3 + reach);
  return {
    n: sorted.length,
    min: sorted[0]!,
    q1,
    median: quantile(sorted, 0.5),
    q3,
    max: sorted[sorted.length - 1]!,
    // The quartiles always lie inside the fences, so `inside` is never empty.
    low: inside[0]!,
    high: inside[inside.length - 1]!,
    outliers: sorted.filter((value) => value < q1 - reach || value > q3 + reach),
  };
}

/** More bins than this stop reading as a shape. */
const MAX_BINS = 40;

/** 1, 2 or 5 × 10ⁿ nearest `raw` on a log scale (rounding up could double a bin), never finer than `finest`. */
function binWidth(raw: number, finest: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const nearest = [1, 2, 5, 10]
    .map((factor) => factor * power)
    .reduce((best, width) => (Math.abs(Math.log(width / raw)) < Math.abs(Math.log(best / raw)) ? width : best));
  return nearest >= finest ? nearest : niceStep(finest, 1);
}

/**
 * Automatic bin edges for ascending values: the finer of the Freedman–Diaconis
 * (2 IQR / ∛n) and Sturges (range / (⌈log₂n⌉ + 1)) widths, like NumPy's "auto"
 * picks (Freedman–Diaconis alone is coarse for small samples, and zero when
 * the IQR is), taken as the nearest 1, 2 or 5 × 10ⁿ, edges at its multiples.
 * Equal values get one bin centred on them.
 */
export function autoEdges(sorted: readonly number[]): number[] {
  if (sorted.length === 0) return [];
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  if (min === max) {
    const width = niceStep(Math.abs(min) / 5 || 1, 1);
    return [clean(min - width / 2), clean(min + width / 2)];
  }
  const n = sorted.length;
  const fd = (2 * (quantile(sorted, 0.75) - quantile(sorted, 0.25))) / Math.cbrt(n);
  const sturges = (max - min) / (Math.ceil(Math.log2(n)) + 1);
  const width = binWidth(fd > 0 ? Math.min(fd, sturges) : sturges, (max - min) / MAX_BINS);
  const edges = [clean(Math.floor(min / width) * width)];
  while (edges[edges.length - 1]! < max) edges.push(clean(edges[0]! + edges.length * width));
  return edges;
}

export const EDGES_ERROR = "A histogram's labels are its bin edges: ascending numbers, or [] for automatic bins";

/** Bin edges written as labels: numbers (or numeric strings), at least two, strictly ascending; null otherwise. */
export function readEdges(labels: readonly unknown[]): number[] | null {
  const edges = labels.map((label) =>
    typeof label === "number" ? label : typeof label === "string" && label.trim() !== "" ? Number(label.trim()) : NaN,
  );
  const ascending = edges.every((edge, index) => Number.isFinite(edge) && (index === 0 || edge > edges[index - 1]!));
  return edges.length >= 2 && ascending ? edges : null;
}

export interface Histogram {
  /** Bin `i` runs from `edges[i]` up to `edges[i + 1]`; the last bin includes its upper edge. */
  readonly edges: readonly number[];
  /** Per group, its count in each bin. */
  readonly counts: readonly (readonly number[])[];
  /** Values below the first edge or above the last, left out. */
  readonly outside: number;
}

/**
 * Every group counted into the same bins: the labels' edges, or automatic
 * ones over all groups' values together. Null when the labels are not edges.
 */
export function histogram(labels: readonly unknown[], groups: readonly (readonly number[])[]): Histogram | null {
  const edges = labels.length === 0 ? autoEdges(groups.flat().sort((a, b) => a - b)) : readEdges(labels);
  if (edges === null) return null;
  const last = edges.length - 1;
  let outside = 0;
  const counts = groups.map((values) => {
    const bins = Array.from({ length: Math.max(0, last) }, () => 0);
    for (const value of values) {
      if (last < 1 || value < edges[0]! || value > edges[last]!) {
        outside++;
        continue;
      }
      let bin = 0;
      while (bin < last - 1 && value >= edges[bin + 1]!) bin++;
      bins[bin]!++;
    }
    return bins;
  });
  return { edges, counts, outside };
}

/** What a distribution chart left out, as one line under it; null when it kept every value. */
export function leftOutNote(dropped: number, outside: number): string | null {
  const parts = [
    dropped > 0 ? `${dropped} empty or non-numeric ${dropped === 1 ? "value" : "values"}` : null,
    outside > 0 ? `${outside} outside the bins` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : `${parts.join(" and ")} left out`;
}
