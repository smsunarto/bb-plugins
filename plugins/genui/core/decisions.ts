// The pure logic of the Decisions components (Plan, Decision, Estimate): reading
// their props, the message an approved Plan sends, a Decision's weighted
// ranking and an Estimate's three-point (PERT) totals. Shared by the renderers
// in ui/components/decisions.tsx and the markdown fallback in core/markdown.ts.

import { isPlainObject } from "./evaluate";
import type { Value } from "./types";

/** An item's fields by key; a non-object item stands for its main field (a bare string is a title). */
type Fields = { readonly [key: string]: Value | undefined };

/** A scalar as trimmed text; anything else is empty. */
function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return "";
}

/** A finite number, also from numeric text ("2.5"); null otherwise. */
export function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*-?(\d+(\.\d*)?|\.\d+)\s*$/.test(value)) return Number(value);
  return null;
}

/** A number without float noise, at most `digits` decimals: 2.5, 1.33, 12. */
export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** One decimal at most, grouped: 1,250.5. */
export function formatAmount(value: number): string {
  return NUMBER.format(value === 0 ? 0 : value);
}

/** "1, 2 and 4"; runs of three or more read as ranges: "1–3, 5 and 7–9". */
export function numberList(numbers: readonly number[]): string {
  const parts: string[] = [];
  for (let index = 0; index < numbers.length; ) {
    let end = index;
    while (end + 1 < numbers.length && numbers[end + 1] === numbers[end] + 1) end++;
    if (end - index >= 2) {
      parts.push(`${numbers[index]}–${numbers[end]}`);
      index = end + 1;
    } else {
      parts.push(String(numbers[index]));
      index++;
    }
  }
  return joinAnd(parts);
}

/** "a", "a and b", "a, b and c". */
export function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Plan

export type Risk = "low" | "medium" | "high";

export interface PlanFile {
  readonly path: string;
  readonly line: number | null;
}

/** A parsed estimate: an amount in a unit ("" for a bare number). */
export interface Quantity {
  readonly value: number;
  readonly unit: string;
}

export interface PlanStep {
  readonly title: string;
  readonly detail: string | null;
  readonly files: readonly PlanFile[];
  readonly risk: Risk | null;
  /** The estimate as written ("2h", "half a day"); null when none. */
  readonly estimate: string | null;
  /** The estimate as an amount, when it is one. */
  readonly amount: Quantity | null;
  readonly optional: boolean;
}

const RISKS: Record<string, Risk> = { low: "low", medium: "medium", med: "medium", moderate: "medium", high: "high" };

/** `path`, `path:12`, `path:12:3`, or `{path, line?}`. */
function planFile(value: Value): PlanFile | null {
  if (isPlainObject(value)) {
    const fields: Fields = value;
    const path = str(fields.path ?? fields.file);
    if (path === "") return null;
    const line = readNumber(fields.line);
    return { path, line: line !== null && line >= 1 ? Math.floor(line) : null };
  }
  const raw = str(value);
  if (raw === "") return null;
  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(raw);
  return match !== null && match[1] !== "" ? { path: match[1], line: Number(match[2]) } : { path: raw, line: null };
}

/** Time units in minutes, with a working day of 8 h and a week of 5 days. */
const TIME_MINUTES: Record<string, number> = { m: 1, h: 60, d: 8 * 60, w: 5 * 8 * 60 };

const UNIT_ALIASES: [RegExp, string][] = [
  [/^(m|min|mins|minutes?)$/i, "m"],
  [/^(h|hr|hrs|hours?)$/i, "h"],
  [/^(d|days?)$/i, "d"],
  [/^(w|wk|wks|weeks?)$/i, "w"],
  [/^(pts?|points?|sp)$/i, "pts"],
];

/** A unit word as one of m, h, d, w, pts; other words stay as written. */
export function normalizeUnit(unit: string): string {
  const trimmed = unit.trim();
  for (const [pattern, name] of UNIT_ALIASES) if (pattern.test(trimmed)) return name;
  return trimmed;
}

/** "2h", "1.5 d", "~30 min", "3 pts", 4 → a Quantity; ranges and prose → null. */
export function parseQuantity(value: unknown): Quantity | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? { value, unit: "" } : null;
  if (typeof value !== "string") return null;
  const match = /^\s*~?\s*(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)\s*$/i.exec(value);
  if (match === null) return null;
  const unit = normalizeUnit(match[2]);
  if (match[2] !== "" && !(unit in TIME_MINUTES) && unit !== "pts") return null;
  return { value: Number(match[1]), unit };
}

/** "2.5 h", "8 pts", "1 pt", "3". */
export function formatQuantity(quantity: Quantity): string {
  const amount = formatAmount(quantity.value);
  if (quantity.unit === "") return amount;
  if (quantity.unit === "pts") return `${amount} ${quantity.value === 1 ? "pt" : "pts"}`;
  return `${amount} ${quantity.unit === "m" ? "min" : quantity.unit}`;
}

export interface PlanRead {
  readonly steps: readonly PlanStep[];
  readonly error: string | null;
}

/** Steps from a list of `{title, detail?, files?, risk?, estimate?, optional?}` or titles; untitled items (still streaming) are left out. */
export function readPlan(value: Value | undefined): PlanRead {
  if (!Array.isArray(value)) return { steps: [], error: "Plan needs a list of steps" };
  const steps = value.flatMap((item): PlanStep[] => {
    const fields: Fields = isPlainObject(item) ? item : { title: item };
    const title = str(fields.title ?? fields.name ?? fields.step);
    if (title === "") return [];
    const files = (Array.isArray(fields.files) ? fields.files : fields.files === undefined ? [] : [fields.files])
      .map(planFile)
      .filter((file): file is PlanFile => file !== null);
    const estimate = str(fields.estimate) || null;
    return [
      {
        title,
        detail: str(fields.detail ?? fields.description) || null,
        files,
        risk: RISKS[str(fields.risk).toLowerCase()] ?? null,
        estimate,
        amount: estimate === null ? null : parseQuantity(fields.estimate),
        optional: fields.optional === true,
      },
    ];
  });
  return { steps, error: null };
}

/** Which steps start checked: all but the optional ones. */
export function initialChecks(steps: readonly PlanStep[]): boolean[] {
  return steps.map((step) => !step.optional);
}

export interface EstimateTotal {
  /** The sum, or null when the estimates can't be added (mixed points and time) or none is a number. */
  readonly total: Quantity | null;
  /** Steps counted whose estimate isn't a number ("half a day"). */
  readonly unparsed: number;
  readonly mixed: boolean;
}

/**
 * The sum of the estimates of the `included` steps. Time units add up in the
 * largest unit present (a day is 8 h, a week 5 days); points and bare
 * numbers add only to their own kind.
 */
export function planTotal(steps: readonly PlanStep[], included: readonly boolean[]): EstimateTotal {
  const counted = steps.filter((step, index) => included[index] !== false && step.estimate !== null);
  const amounts = counted.flatMap((step) => (step.amount === null ? [] : [step.amount]));
  const unparsed = counted.length - amounts.length;
  if (amounts.length === 0) return { total: null, unparsed, mixed: false };
  const timed = amounts.every((amount) => amount.unit in TIME_MINUTES);
  const units = new Set(amounts.map((amount) => amount.unit));
  if (!timed && units.size > 1) return { total: null, unparsed, mixed: true };
  if (!timed) {
    return { total: { value: round(amounts.reduce((sum, a) => sum + a.value, 0)), unit: amounts[0].unit }, unparsed, mixed: false };
  }
  const largest = ["w", "d", "h", "m"].find((unit) => units.has(unit)) ?? "h";
  const minutes = amounts.reduce((sum, a) => sum + a.value * TIME_MINUTES[a.unit], 0);
  return { total: { value: round(minutes / TIME_MINUTES[largest]), unit: largest }, unparsed, mixed: false };
}

/**
 * What approving the plan answers:
 * - all steps checked: "Go ahead with the plan."
 * - some unchecked: "Go ahead with steps 1, 2 and 4. Skip 3 (Migrate the old rows)."
 * Empty when nothing is checked (nothing to approve).
 */
export function planMessage(steps: readonly PlanStep[], checked: readonly boolean[]): string {
  const kept = steps.flatMap((_, index) => (checked[index] !== false ? [index + 1] : []));
  const skipped = steps.flatMap((step, index) => (checked[index] === false ? [{ number: index + 1, title: step.title }] : []));
  if (kept.length === 0) return "";
  if (skipped.length === 0) return "Go ahead with the plan.";
  const go = `Go ahead with ${kept.length === 1 ? "step" : "steps"} ${numberList(kept)}.`;
  return `${go} Skip ${joinAnd(skipped.map((step) => `${step.number} (${step.title})`))}.`;
}

// ---------------------------------------------------------------------------
// Decision

export interface Criterion {
  readonly name: string;
  readonly weight: number;
  readonly note: string | null;
}

export interface DecisionOption {
  readonly name: string;
  /** One per criterion; null where the option has no (usable) score. */
  readonly scores: readonly (number | null)[];
  readonly pros: readonly string[];
  readonly cons: readonly string[];
  readonly note: string | null;
}

export interface DecisionModel {
  readonly criteria: readonly Criterion[];
  readonly options: readonly DecisionOption[];
  /** The top of the score scale: 5, or 10 / 100 when the scores use those. */
  readonly scale: number;
  /** Input problems the component shows below the matrix. */
  readonly issues: readonly string[];
}

export type DecisionRead = { readonly ok: true; readonly model: DecisionModel } | { readonly ok: false; readonly error: string };

function textList(value: Value | undefined): string[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()];
  return (Array.isArray(value) ? value : []).map(str).filter((item) => item !== "");
}

/** Criteria (names or `{name, weight?, note?}`) and options (`{name, scores: [..] | {criterion: score}, pros?, cons?, note?}`). */
export function readDecision(options: Value | undefined, criteria: Value | undefined): DecisionRead {
  if (!Array.isArray(criteria)) return { ok: false, error: "Decision needs a list of criteria" };
  if (!Array.isArray(options)) return { ok: false, error: "Decision needs a list of options" };
  const issues: string[] = [];
  const readCriteria = criteria.flatMap((item): Criterion[] => {
    const fields: Fields = isPlainObject(item) ? item : { name: item };
    const name = str(fields.name ?? fields.label);
    if (name === "") return [];
    const raw = fields.weight;
    const weight = raw === undefined || raw === null ? 1 : readNumber(raw);
    if (weight === null || weight < 0) issues.push(`Weight ${str(raw) || "?"} for ${name} isn't a number of 0 or more; using 1.`);
    return [{ name, weight: weight === null || weight < 0 ? 1 : weight, note: str(fields.note) || null }];
  });
  if (readCriteria.length === 0) return { ok: false, error: "Decision needs at least one criterion" };
  const byName = new Map(readCriteria.map((criterion, index) => [criterion.name.toLowerCase(), index]));
  const raws: { option: Omit<DecisionOption, "scores">; scores: (number | null)[] }[] = [];
  for (const item of options) {
    const fields: Fields = isPlainObject(item) ? item : { name: item };
    const name = str(fields.name ?? fields.title ?? fields.label);
    if (name === "") continue;
    const scores: (number | null)[] = readCriteria.map(() => null);
    const given = fields.scores;
    const take = (index: number, value: unknown) => {
      if (value === undefined || value === null) return;
      const score = readNumber(value);
      if (score === null || score < 0) issues.push(`${name}: score ${str(value) || "?"} for ${readCriteria[index].name} isn't a number of 0 or more.`);
      else scores[index] = score;
    };
    if (Array.isArray(given)) {
      given.slice(0, readCriteria.length).forEach((value, index) => take(index, value));
      if (given.length > readCriteria.length) issues.push(`${name} has ${given.length} scores for ${readCriteria.length} criteria; the extra ones are ignored.`);
    } else if (given !== undefined && isPlainObject(given)) {
      for (const [key, value] of Object.entries(given)) {
        const index = byName.get(key.trim().toLowerCase());
        if (index === undefined) issues.push(`${name} scores “${key}”, which isn't a criterion.`);
        else take(index, value);
      }
    }
    raws.push({
      option: { name, pros: textList(fields.pros), cons: textList(fields.cons), note: str(fields.note) || null },
      scores,
    });
  }
  const top = Math.max(0, ...raws.flatMap((raw) => raw.scores.filter((score): score is number => score !== null)));
  const scale = top <= 5 ? 5 : top <= 10 ? 10 : 100;
  if (top > 100) issues.push("Scores above 100 are counted as 100.");
  const missing = raws.reduce((count, raw) => count + raw.scores.filter((score) => score === null).length, 0);
  if (missing > 0) issues.push(`${missing === 1 ? "One score is" : `${missing} scores are`} missing and ${missing === 1 ? "counts" : "count"} as 0.`);
  return {
    ok: true,
    model: {
      criteria: readCriteria,
      options: raws.map(({ option, scores }) => ({ ...option, scores: scores.map((score) => (score === null ? null : Math.min(score, scale))) })),
      scale,
      issues,
    },
  };
}

export interface Ranked {
  /** The option's position in `model.options`. */
  readonly index: number;
  /** Weighted mean score on the model's scale: Σ wᵢ·sᵢ / Σ wᵢ (a missing score counts as 0). */
  readonly total: number;
}

/** Options by weighted total, best first; ties keep the given order. All weights 0 → every total 0. */
export function rankOptions(model: DecisionModel, weights: readonly number[]): Ranked[] {
  const sum = weights.reduce((total, weight) => total + Math.max(0, weight), 0);
  return model.options
    .map((option, index) => ({
      index,
      total:
        sum === 0
          ? 0
          : option.scores.reduce<number>((total, score, criterion) => total + Math.max(0, weights[criterion] ?? 0) * (score ?? 0), 0) / sum,
    }))
    .sort((a, b) => b.total - a.total || a.index - b.index);
}

/** How the leader stands: ahead by `margin` (on the score scale), tied, or alone. */
export function leaderMargin(ranked: readonly Ranked[]): { margin: number; tied: number[] } | null {
  if (ranked.length === 0) return null;
  const top = ranked[0].total;
  // Totals equal to two decimals are a tie: a difference the matrix can't show isn't a win.
  const tied = ranked.slice(1).filter((entry) => round(entry.total) === round(top)).map((entry) => entry.index);
  return { margin: ranked.length > 1 ? top - ranked[1].total : 0, tied };
}

/** The ± step of the weight controls: 1 for whole weights up to 10, 5 or 10 for percent-like ones, 0.05 for fractions. */
export function weightStep(weights: readonly number[]): number {
  const top = Math.max(0, ...weights);
  if (weights.every(Number.isInteger)) return top <= 10 ? 1 : top <= 50 ? 5 : 10;
  return top <= 1 ? 0.05 : 0.5;
}

/** The largest weight the controls allow: room to double the heaviest given weight, at least ten steps. */
export function weightMax(weights: readonly number[]): number {
  const step = weightStep(weights);
  return Math.max(step * 10, round(Math.max(0, ...weights) * 2, 4));
}

/** A weight moved by `steps` steps, kept on the step grid within [0, max]. */
export function nudgeWeight(weight: number, steps: number, step: number, max: number): number {
  return round(Math.min(max, Math.max(0, Math.round(weight / step + steps) * step)), 4);
}

/**
 * What "Go with <option>" sends: "Go with BullMQ." and, when the user moved
 * any weight, the weights they settled on, so the agent knows why.
 */
export function decisionMessage(model: DecisionModel, option: number, weights: readonly number[]): string {
  const go = `Go with ${model.options[option]?.name ?? ""}.`;
  const changed = model.criteria.some((criterion, index) => weights[index] !== criterion.weight);
  if (!changed) return go;
  return `${go} My weights: ${model.criteria.map((criterion, index) => `${criterion.name} ${round(weights[index] ?? 0, 4)}`).join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Estimate

export interface EstimateTask {
  readonly title: string;
  readonly low: number | null;
  readonly likely: number | null;
  readonly high: number | null;
}

export interface TaskEstimate {
  readonly task: EstimateTask;
  /** Why the row can't be counted; null when it is valid. */
  readonly error: string | null;
  /** The likely value used: as given, else the midpoint of low and high. */
  readonly likely: number;
  /** PERT mean: (low + 4·likely + high) / 6. */
  readonly mean: number;
  /** PERT standard deviation: (high − low) / 6. */
  readonly sd: number;
}

/** z-scores of the standard normal distribution at 80 % and 90 %. */
export const Z80 = 0.8416212335729143;
export const Z90 = 1.2815515655446004;

/** Tasks from `{title, low, high, likely?}` (numbers or numeric text); untitled items get "Task n". */
export function readEstimate(value: Value | undefined): { tasks: EstimateTask[]; error: string | null } {
  if (!Array.isArray(value)) return { tasks: [], error: "Estimate needs a list of tasks" };
  const tasks = value.flatMap((item, index): EstimateTask[] => {
    if (!isPlainObject(item)) {
      const title = str(item);
      return title === "" ? [] : [{ title, low: null, likely: null, high: null }];
    }
    return [
      {
        title: str(item.title ?? item.name ?? item.task) || `Task ${index + 1}`,
        low: readNumber(item.low ?? item.min ?? item.optimistic),
        likely: readNumber(item.likely ?? item.mostLikely ?? item.expected),
        high: readNumber(item.high ?? item.max ?? item.pessimistic),
      },
    ];
  });
  return { tasks, error: null };
}

/** One task's PERT figures, or why it can't be counted. */
export function estimateTask(task: EstimateTask): TaskEstimate {
  const { low, high } = task;
  const fail = (error: string): TaskEstimate => ({ task, error, likely: 0, mean: 0, sd: 0 });
  if (low === null && high === null) return fail("needs low and high");
  if (low === null) return fail("needs low");
  if (high === null) return fail("needs high");
  if (low < 0 || high < 0 || (task.likely !== null && task.likely < 0)) return fail("estimates can't be negative");
  if (low > high) return fail(`low ${formatAmount(low)} is above high ${formatAmount(high)}`);
  const likely = task.likely ?? (low + high) / 2;
  if (likely < low || likely > high) return fail(`likely ${formatAmount(likely)} is outside ${formatAmount(low)}–${formatAmount(high)}`);
  return { task, error: null, likely, mean: (low + 4 * likely + high) / 6, sd: (high - low) / 6 };
}

export interface EstimateTotals {
  /** Valid tasks counted. */
  readonly count: number;
  /** Invalid tasks left out. */
  readonly excluded: number;
  readonly low: number;
  readonly high: number;
  readonly mean: number;
  readonly sd: number;
  readonly p50: number;
  readonly p80: number;
  readonly p90: number;
}

/**
 * The project total of the valid tasks. Treating tasks as independent, the
 * means add and so do the variances (σ² = Σ σᵢ²). By the central limit
 * theorem the sum is close to normal, so P(x) = mean + z(x)·σ: P50 is the
 * mean, P80 adds 0.84 σ, P90 1.28 σ. The normal tail can pass the sum of
 * the highs (few tasks, likely near high), which no outcome can exceed, so
 * the percentiles are clamped to [Σ low, Σ high].
 */
export function estimateTotals(estimates: readonly TaskEstimate[]): EstimateTotals {
  const valid = estimates.filter((estimate) => estimate.error === null);
  const low = valid.reduce((sum, e) => sum + (e.task.low ?? 0), 0);
  const high = valid.reduce((sum, e) => sum + (e.task.high ?? 0), 0);
  const mean = valid.reduce((sum, e) => sum + e.mean, 0);
  const sd = Math.sqrt(valid.reduce((sum, e) => sum + e.sd * e.sd, 0));
  const clamp = (value: number) => Math.min(high, Math.max(low, value));
  return {
    count: valid.length,
    excluded: estimates.length - valid.length,
    low,
    high,
    mean,
    sd,
    p50: clamp(mean),
    p80: clamp(mean + Z80 * sd),
    p90: clamp(mean + Z90 * sd),
  };
}

/** Edits the user made inline, by task index. */
export type EstimateEdits = Readonly<Record<string, Partial<Record<"low" | "likely" | "high", number | null>>>>;

/** The tasks with the user's edits applied; an edit to null clears a likely (back to the midpoint). */
export function applyEdits(tasks: readonly EstimateTask[], edits: EstimateEdits): EstimateTask[] {
  return tasks.map((task, index) => {
    const edit = edits[String(index)];
    if (edit === undefined) return task;
    return {
      ...task,
      low: edit.low !== undefined ? edit.low : task.low,
      likely: edit.likely !== undefined ? edit.likely : task.likely,
      high: edit.high !== undefined ? edit.high : task.high,
    };
  });
}

/** Stored edits as written by the component, or null for anything else. */
export function acceptEdits(stored: unknown): EstimateEdits | null {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return null;
  for (const edit of Object.values(stored)) {
    if (typeof edit !== "object" || edit === null || Array.isArray(edit)) return null;
    for (const [key, value] of Object.entries(edit)) {
      if (!["low", "likely", "high"].includes(key) || (value !== null && readNumber(value) === null)) return null;
    }
  }
  return stored as EstimateEdits;
}

const UNIT_LABELS: Record<string, string> = { m: "min", h: "h", d: "d", w: "w", pts: "pts" };

/** An Estimate's unit: h, d (default), w, pts, or any word as written. */
export function estimateUnit(value: unknown): string {
  const raw = str(value);
  if (raw === "") return "d";
  const unit = normalizeUnit(raw);
  return UNIT_LABELS[unit] ?? unit;
}

/** "3.5 d", "8 pts", "1 pt". */
export function formatWithUnit(value: number, unit: string): string {
  if (unit === "pts") return `${formatAmount(value)} ${round(value, 1) === 1 ? "pt" : "pts"}`;
  return `${formatAmount(value)} ${unit}`;
}
