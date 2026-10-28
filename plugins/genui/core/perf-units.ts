// Units for performance data (Benchmark, Waterfall, Treemap): what a unit word
// measures, values auto-scaled to the unit a person would read them in
// (0.0277 ms → 27.7 µs, 349438 B → 341 KB), signed deltas, and axis ticks;
// and the one field reader their parsers share. Pure, shared by the renderers
// and the markdown fallback.
import { isPlainObject } from "./evaluate";
import type { Value } from "./types";

/** An object's fields by key. */
export type Fields = { readonly [key: string]: Value };

/**
 * `value` as fields to read by key when it is a plain object, else null.
 * Takes the `undefined` an absent field reads as, and widens past the Action
 * shapes isPlainObject's narrowing keeps, like markdown.ts's `fields`.
 */
export function objectFields(value: Value | undefined): Fields | null {
  return value !== undefined && isPlainObject(value) ? value : null;
}

export type UnitKind = "time" | "bytes" | "rate" | "percent" | "count";

export interface UnitInfo {
  readonly kind: UnitKind;
  /** Multiplier from the unit to its kind's base: seconds, bytes, per second; 1 for percent and counts. */
  readonly factor: number;
  /** The unit as written, for counts (`"req"`, `"$"`); null when there is none. */
  readonly label: string | null;
}

const TIME: Record<string, number> = {
  ns: 1e-9,
  nanosecond: 1e-9,
  nanoseconds: 1e-9,
  us: 1e-6,
  "µs": 1e-6,
  "μs": 1e-6,
  microsecond: 1e-6,
  microseconds: 1e-6,
  ms: 1e-3,
  millisecond: 1e-3,
  milliseconds: 1e-3,
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
};

/** Bytes are counted in 1,024s, as `du`, esbuild and most dev tools do. */
const BYTES: Record<string, number> = {
  b: 1,
  byte: 1,
  bytes: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

const RATE = /^(?:ops?|req|requests|queries|it|iterations|runs|frames|events)\s*\/\s*(?:s|sec|second)$|^(?:hz|rps|qps|fps)$/i;

/** What `unit` measures; anything unknown is a count labelled with the unit. */
export function unitInfo(unit: string | null | undefined): UnitInfo {
  const raw = (unit ?? "").trim();
  if (raw === "") return { kind: "count", factor: 1, label: null };
  if (raw === "%") return { kind: "percent", factor: 1, label: "%" };
  const lower = raw.toLowerCase();
  if (Object.hasOwn(TIME, raw)) return { kind: "time", factor: TIME[raw], label: raw };
  if (Object.hasOwn(TIME, lower) && lower !== "m") return { kind: "time", factor: TIME[lower], label: raw };
  if (Object.hasOwn(BYTES, lower)) return { kind: "bytes", factor: BYTES[lower], label: raw };
  if (RATE.test(raw)) return { kind: "rate", factor: 1, label: /^hz$/i.test(raw) ? "ops/s" : raw };
  return { kind: "count", factor: 1, label: raw };
}

/** `value` to `digits` significant digits, grouped (12,345 · 18.4 · 1.84 · 0.000123). */
export function significant(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const decimals = Math.min(6, Math.max(0, digits - 1 - magnitude));
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals, minimumFractionDigits: 0 }).format(
    Number(value.toFixed(decimals)),
  );
}

/** Currency symbols lead (`$5`); other units trail (`5%`, `5 ms`). */
function attach(number: string, unit: string | null): string {
  if (unit === null || unit === "") return number;
  if (/^[$€£¥]$/.test(unit)) return number.startsWith("-") || number.startsWith("−") ? `${number[0]}${unit}${number.slice(1)}` : `${unit}${number}`;
  if (unit === "%") return `${number}%`;
  return `${number} ${unit}`;
}

/** The divisor and label that read a time of `seconds` best: ns, µs, ms, s, min or h. */
function timeScale(seconds: number): [number, string] {
  const size = Math.abs(seconds);
  if (size === 0) return [1e-3, "ms"];
  if (size < 1e-6) return [1e-9, "ns"];
  if (size < 1e-3) return [1e-6, "µs"];
  if (size < 1) return [1e-3, "ms"];
  if (size < 120) return [1, "s"];
  if (size < 7200) return [60, "min"];
  return [3600, "h"];
}

function byteScale(bytes: number): [number, string] {
  const size = Math.abs(bytes);
  if (size < 1024) return [1, "B"];
  if (size < 1024 ** 2) return [1024, "KB"];
  if (size < 1024 ** 3) return [1024 ** 2, "MB"];
  if (size < 1024 ** 4) return [1024 ** 3, "GB"];
  return [1024 ** 4, "TB"];
}

function countScale(value: number): [number, string] {
  const size = Math.abs(value);
  if (size < 1e4) return [1, ""];
  if (size < 1e6) return [1e3, "K"];
  if (size < 1e9) return [1e6, "M"];
  return [1e9, "B"];
}

/**
 * `value` (in `unit`) as a person reads it: 0.0277 ms → "27.7 µs", 349438 B →
 * "341 KB", 36074 ops/s → "36.1K ops/s". `scaleBy` picks the scale instead of
 * the value itself, so a spread reads in its mean's unit ("7.8 ms ± 0.75 ms").
 */
export function formatAmount(value: number, unit: string | null | undefined, digits = 3, scaleBy = value): string {
  if (!Number.isFinite(value)) return "—";
  const info = unitInfo(unit);
  switch (info.kind) {
    case "time": {
      const [divisor, label] = timeScale((Number.isFinite(scaleBy) ? scaleBy : value) * info.factor);
      return `${significant((value * info.factor) / divisor, digits)} ${label}`;
    }
    case "bytes": {
      const [divisor, label] = byteScale((Number.isFinite(scaleBy) ? scaleBy : value) * info.factor);
      const scaled = (value * info.factor) / divisor;
      return `${label === "B" ? significant(Math.round(scaled), Math.max(digits, 4)) : significant(scaled, digits)} ${label}`;
    }
    case "rate": {
      const [divisor, suffix] = countScale(Number.isFinite(scaleBy) ? scaleBy : value);
      return `${significant(value / divisor, digits)}${suffix} ${info.label}`;
    }
    case "percent":
      return `${significant(value, digits)}%`;
    case "count": {
      // Plain counts keep every digit up to 10,000 (1,234 req), then compact.
      const [divisor, suffix] = countScale(Number.isFinite(scaleBy) ? scaleBy : value);
      const number = suffix === "" && Number.isInteger(value) ? significant(value, 12) : `${significant(value / divisor, digits)}${suffix}`;
      return attach(number, info.label);
    }
  }
}

/** A signed amount: "+1.2 ms", "−340 KB"; zero is "±0". */
export function formatDelta(value: number, unit: string | null | undefined, digits = 3): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return `±${formatAmount(0, unit, digits)}`;
  const body = formatAmount(Math.abs(value), unit, digits);
  return `${value > 0 ? "+" : "−"}${body}`;
}

/** A signed percent: "+12.3%", "−0.4%", "±0%"; slivers read "<0.1%" with their sign. */
export function formatPercent(percent: number): string {
  if (!Number.isFinite(percent)) return "—";
  if (percent === 0) return "±0%";
  const sign = percent > 0 ? "+" : "−";
  const size = Math.abs(percent);
  if (size < 0.1) return `${sign}<0.1%`;
  return `${sign}${size >= 100 ? significant(size, 4) : size.toFixed(1)}%`;
}

/** A milliseconds duration, auto-scaled (Waterfall's internal unit). */
export function formatMs(ms: number, digits = 3): string {
  return formatAmount(ms, "ms", digits);
}

/** A byte count, auto-scaled. */
export function formatBytes(bytes: number, digits = 3): string {
  return formatAmount(bytes, "B", digits);
}

/** A share of a whole: "41%", "3.2%", "<0.1%". */
export function formatShare(part: number, whole: number): string {
  if (!(whole > 0) || !(part >= 0)) return "";
  const percent = (part / whole) * 100;
  if (percent === 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

/** The step of a nice axis (1, 2 or 5 × 10ⁿ) splitting `span` into about `count` parts. */
export function niceStep(span: number, count = 5): number {
  if (!(span > 0)) return 1;
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

/** Ticks from `min` to past `max` at a nice step; the axis then runs from the first to the last tick. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max <= min) max = min + (min === 0 ? 1 : Math.abs(min));
  const step = niceStep(max - min, count);
  const start = Math.floor(min / step + 1e-9) * step;
  const ticks: number[] = [];
  for (let tick = start; ticks.length < 50; tick += step) {
    ticks.push(Number(tick.toPrecision(12)));
    if (tick >= max - step * 1e-9) break;
  }
  return ticks;
}
