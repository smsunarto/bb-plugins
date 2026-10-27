// Reading the user's own past choices of model and effort, and scoring how
// well the current routing rules would have reproduced them. Pure helpers;
// server.ts does the I/O.
import { REASONING_LEVELS, type ReasoningLevel } from "./reasoning";

export interface HistoryRow {
  threadId: string;
  createdAt: number;
  project: string;
  providerId: string;
  model: string;
  effort: string;
  prompt: string;
}

/** Greetings and connection tests say nothing about how the user picks models. */
const NOISE =
  /^(hi|hey|hello|yo|test|testing|ping|u up|what'?s? up|how are (you|we)\b.*|reply with .{0,40}|.{0,30}\btest\b.{0,30}reply .{0,40})[.!?]*$/iu;
const MIN_PROMPT_CHARS = 12;

export function isNoise(prompt: string): boolean {
  const text = prompt.replace(/\s+/gu, " ").trim();
  return text.length < MIN_PROMPT_CHARS || NOISE.test(text);
}

export interface ModelMapping {
  /** Matched against the model id the thread actually ran on. */
  pattern: RegExp;
  /** The rotation model id those threads should count as. */
  model: string;
}

/** `pattern=model`, as typed on the command line. */
export function parseMapping(text: string): ModelMapping {
  const at = text.lastIndexOf("=");
  if (at <= 0 || at === text.length - 1) {
    throw new Error(`Expected <regex>=<model id>, got "${text}".`);
  }
  return { pattern: new RegExp(text.slice(0, at), "iu"), model: text.slice(at + 1) };
}

export function mappedModel(model: string, mappings: readonly ModelMapping[]): string {
  return mappings.find((mapping) => mapping.pattern.test(model))?.model ?? model;
}

/** Counts of threads per model and effort, most used model first. */
export function tally(
  rows: readonly HistoryRow[],
): { model: string; total: number; efforts: Record<string, number> }[] {
  const byModel = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const efforts = byModel.get(row.model) ?? {};
    efforts[row.effort] = (efforts[row.effort] ?? 0) + 1;
    byModel.set(row.model, efforts);
  }
  return [...byModel]
    .map(([model, efforts]) => ({
      model,
      efforts,
      total: Object.values(efforts).reduce((sum, count) => sum + count, 0),
    }))
    .sort((a, b) => b.total - a.total);
}

export interface BacktestSelection {
  rows: HistoryRow[];
  skipped: { noise: number; excluded: number; notInRotation: number; duplicate: number };
}

/** One thread per distinct prompt, model, and effort; noise and excluded prompts dropped. */
export function backtestRows(
  rows: readonly HistoryRow[],
  options: {
    mappings: readonly ModelMapping[];
    exclude: RegExp | null;
    rotation: ReadonlySet<string>;
  },
): BacktestSelection {
  const skipped = { noise: 0, excluded: 0, notInRotation: 0, duplicate: 0 };
  const seen = new Set<string>();
  const kept: HistoryRow[] = [];
  for (const row of rows) {
    const model = mappedModel(row.model, options.mappings);
    if (isNoise(row.prompt)) skipped.noise++;
    else if (options.exclude?.test(row.prompt)) skipped.excluded++;
    else if (!options.rotation.has(model)) skipped.notInRotation++;
    else {
      const key = JSON.stringify([row.prompt.trim(), model, row.effort]);
      if (seen.has(key)) skipped.duplicate++;
      else {
        seen.add(key);
        kept.push({ ...row, model });
      }
    }
  }
  return { rows: kept, skipped };
}

export interface BacktestResult {
  row: HistoryRow;
  model: string;
  effort: string;
}

const percent = (part: number, whole: number) =>
  whole === 0 ? 0 : Math.round((part / whole) * 100);

function mostCommon(values: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function confusion(pairs: readonly (readonly [string, string])[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [actual, picked] of pairs) {
    const key = `${actual} -> ${picked}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * How often the rules reproduced the user's choice, next to what always
 * picking the user's most common choice would score. `allowedEfforts` limits
 * effort scoring to levels the rules are able to pick.
 */
export function score(results: readonly BacktestResult[], allowedEfforts: ReadonlySet<string>) {
  const effortScored = results.filter((result) => allowedEfforts.has(result.row.effort));
  const rank = (effort: string) => REASONING_LEVELS.indexOf(effort as ReasoningLevel);
  const topModel = mostCommon(results.map((result) => result.row.model));
  const topEffort = mostCommon(effortScored.map((result) => result.row.effort));
  return {
    prompts: results.length,
    model: {
      agreementPercent: percent(
        results.filter((result) => result.model === result.row.model).length,
        results.length,
      ),
      alwaysMostCommonPercent: percent(
        results.filter((result) => result.row.model === topModel).length,
        results.length,
      ),
      mostCommon: topModel,
      confusion: confusion(results.map((result) => [result.row.model, result.model] as const)),
    },
    effort: {
      scored: effortScored.length,
      agreementPercent: percent(
        effortScored.filter((result) => result.effort === result.row.effort).length,
        effortScored.length,
      ),
      withinOneLevelPercent: percent(
        effortScored.filter(
          (result) => Math.abs(rank(result.effort) - rank(result.row.effort)) <= 1,
        ).length,
        effortScored.length,
      ),
      alwaysMostCommonPercent: percent(
        effortScored.filter((result) => result.row.effort === topEffort).length,
        effortScored.length,
      ),
      mostCommon: topEffort,
      confusion: confusion(
        effortScored.map((result) => [result.row.effort, result.effort] as const),
      ),
    },
  };
}
