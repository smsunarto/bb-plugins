// Pure logic behind the self-contained widgets (Timer, Quiz, Flashcards):
// no React, no DOM, so it is unit-testable without the host modules.
import type { Value } from "../../core/types";
import { isObject, isScalar, list, optionalText, text } from "../values";

// ── Timer ────────────────────────────────────────────────────────────────

/**
 * A run/pause clock as timestamps, never as a tick count, so it stays right
 * when the tab is backgrounded and intervals are throttled.
 */
export interface Clock {
  /** Milliseconds accumulated over finished runs. */
  readonly banked: number;
  /** When the current run started (epoch ms), or null while stopped. */
  readonly startedAt: number | null;
}

export const STOPPED: Clock = { banked: 0, startedAt: null };

export function elapsedMs(clock: Clock, now: number): number {
  return clock.banked + (clock.startedAt === null ? 0 : Math.max(0, now - clock.startedAt));
}

export function startClock(clock: Clock, now: number): Clock {
  return clock.startedAt === null ? { banked: clock.banked, startedAt: now } : clock;
}

export function pauseClock(clock: Clock, now: number): Clock {
  return clock.startedAt === null ? clock : { banked: elapsedMs(clock, now), startedAt: null };
}

/** Milliseconds left of a `totalMs` countdown, never below zero. */
export function remainingMs(clock: Clock, totalMs: number, now: number): number {
  return Math.max(0, totalMs - elapsedMs(clock, now));
}

/**
 * `mm:ss`, or `h:mm:ss` from an hour up (or always, with `hours`, so a long
 * countdown keeps one width as it crosses the hour).
 */
export function formatClock(totalSeconds: number, hours = false): string {
  const whole = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 || hours ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** The countdown readout: a started second still shows until it is fully spent. */
export function countdownSeconds(remaining: number): number {
  return Math.ceil(remaining / 1000);
}

// ── Quiz ─────────────────────────────────────────────────────────────────

export interface QuizQuestion {
  readonly q: string;
  readonly options: readonly string[];
  /** 0-based index into `options`. */
  readonly answer: number;
  readonly why: string | null;
}

/**
 * The correct option's index: a 0-based integer in range, or the option's
 * text (exact first, then ignoring case and surrounding space).
 */
export function resolveAnswer(answer: unknown, options: readonly string[]): number | null {
  if (typeof answer === "number") {
    return Number.isInteger(answer) && answer >= 0 && answer < options.length ? answer : null;
  }
  if (typeof answer !== "string") return null;
  const exact = options.indexOf(answer);
  if (exact >= 0) return exact;
  const wanted = answer.trim().toLowerCase();
  if (wanted === "") return null;
  const loose = options.findIndex((option) => option.trim().toLowerCase() === wanted);
  return loose >= 0 ? loose : null;
}

/** One question, or null when it cannot be asked (no prompt, under two options, no valid answer). */
export function parseQuestion(item: unknown): QuizQuestion | null {
  if (!isObject(item)) return null;
  const q = text(item.q).trim();
  const rawOptions: readonly unknown[] = Array.isArray(item.options) ? item.options : [];
  if (q === "" || rawOptions.length < 2 || !rawOptions.every(isScalar)) return null;
  const options = rawOptions.map(text);
  if (options.some((option) => option.trim() === "")) return null;
  const answer = resolveAnswer(item.answer, options);
  if (answer === null) return null;
  const why = optionalText(item.why)?.trim() || null;
  return { q, options, answer, why };
}

export function parseQuestions(items: Value | undefined): {
  questions: QuizQuestion[];
  skipped: number;
} {
  const all = list(items);
  const questions = all.map(parseQuestion).filter((question) => question !== null);
  return { questions, skipped: all.length - questions.length };
}

/** How many picks match their question's answer; unanswered questions count as wrong. */
export function quizScore(
  questions: readonly QuizQuestion[],
  picks: readonly (number | null | undefined)[],
): number {
  return questions.reduce((sum, question, index) => sum + (picks[index] === question.answer ? 1 : 0), 0);
}

// ── Flashcards ───────────────────────────────────────────────────────────

export interface Flashcard {
  readonly front: string;
  readonly back: string;
}

/** Cards with a front; a missing back is shown as empty rather than dropped. */
export function parseCards(items: Value | undefined): Flashcard[] {
  const cards: Flashcard[] = [];
  const entries: readonly unknown[] = list(items);
  for (const item of entries) {
    if (!isObject(item)) continue;
    const front = text(item.front).trim();
    if (front === "") continue;
    cards.push({ front, back: text(item.back).trim() });
  }
  return cards;
}

/**
 * A viewing order for `count` cards built on `order`: positions that no
 * longer exist are dropped and new ones (cards still streaming in) appended.
 */
export function reconcileOrder(order: readonly number[], count: number): number[] {
  const seen = new Set<number>();
  const kept = order.filter((index) => {
    const keep = Number.isInteger(index) && index >= 0 && index < count && !seen.has(index);
    seen.add(index);
    return keep;
  });
  for (let index = 0; index < count; index++) if (!seen.has(index)) kept.push(index);
  return kept;
}

/**
 * A Fisher–Yates permutation of `order`. A shuffle that lands on the same
 * order would look like a dead button, so that case swaps the first two.
 */
export function shuffleOrder(order: readonly number[], random: () => number = Math.random): number[] {
  const result = [...order];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  if (result.length > 1 && result.every((value, index) => value === order[index])) {
    [result[0], result[1]] = [result[1]!, result[0]!];
  }
  return result;
}
