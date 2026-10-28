import { describe, expect, it } from "vitest";
import {
  countdownSeconds,
  elapsedMs,
  formatClock,
  parseCards,
  parseQuestion,
  parseQuestions,
  pauseClock,
  quizScore,
  reconcileOrder,
  remainingMs,
  resolveAnswer,
  shuffleOrder,
  startClock,
  STOPPED,
} from "./widget-logic";

describe("formatClock", () => {
  it("shows mm:ss under an hour and h:mm:ss from an hour up", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(65)).toBe("01:05");
    expect(formatClock(3599)).toBe("59:59");
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(36_000 + 62)).toBe("10:01:02");
  });

  it("can keep the hour field so a long countdown holds its width", () => {
    expect(formatClock(59 * 60 + 59, true)).toBe("0:59:59");
  });

  it("floors fractions and clamps junk to zero", () => {
    expect(formatClock(9.99)).toBe("00:09");
    expect(formatClock(-5)).toBe("00:00");
    expect(formatClock(Number.NaN)).toBe("00:00");
  });

  it("counts a started countdown second until it is fully spent", () => {
    expect(countdownSeconds(10_000)).toBe(10);
    expect(countdownSeconds(9_001)).toBe(10);
    expect(countdownSeconds(1)).toBe(1);
    expect(countdownSeconds(0)).toBe(0);
  });
});

describe("clock", () => {
  it("measures from timestamps across pauses, however rarely it is read", () => {
    let clock = startClock(STOPPED, 1_000);
    expect(elapsedMs(clock, 4_500)).toBe(3_500);
    clock = pauseClock(clock, 5_000);
    // Time while paused does not count.
    expect(elapsedMs(clock, 60_000)).toBe(4_000);
    clock = startClock(clock, 100_000);
    // A backgrounded tab that wakes after a minute sees the whole minute.
    expect(elapsedMs(clock, 160_000)).toBe(64_000);
  });

  it("ignores repeated start and pause", () => {
    const running = startClock(STOPPED, 1_000);
    expect(startClock(running, 9_000)).toBe(running);
    const paused = pauseClock(running, 2_000);
    expect(pauseClock(paused, 9_000)).toBe(paused);
  });

  it("never counts a countdown below zero", () => {
    const clock = startClock(STOPPED, 0);
    expect(remainingMs(clock, 5_000, 2_000)).toBe(3_000);
    expect(remainingMs(clock, 5_000, 99_000)).toBe(0);
  });
});

describe("resolveAnswer", () => {
  const options = ["Paris", "Lyon", "Nice"];

  it("takes an in-range 0-based index", () => {
    expect(resolveAnswer(0, options)).toBe(0);
    expect(resolveAnswer(2, options)).toBe(2);
    expect(resolveAnswer(3, options)).toBeNull();
    expect(resolveAnswer(-1, options)).toBeNull();
    expect(resolveAnswer(1.5, options)).toBeNull();
  });

  it("takes the correct option's text, loosely if need be", () => {
    expect(resolveAnswer("Lyon", options)).toBe(1);
    expect(resolveAnswer("  nice ", options)).toBe(2);
    expect(resolveAnswer("Marseille", options)).toBeNull();
    expect(resolveAnswer("", options)).toBeNull();
    expect(resolveAnswer(true, options)).toBeNull();
  });
});

describe("parseQuestions", () => {
  it("keeps valid questions and counts the rest as skipped", () => {
    const { questions, skipped } = parseQuestions([
      { q: "Capital of France?", options: ["Paris", "Lyon"], answer: 0, why: "It is." },
      { q: "No options", options: [], answer: 0 },
      { q: "Out of range", options: ["a", "b"], answer: 2 },
      { q: "By text", options: ["a", "b"], answer: "b" },
      "not an object",
      { q: "", options: ["a", "b"], answer: 0 },
    ]);
    expect(questions).toEqual([
      { q: "Capital of France?", options: ["Paris", "Lyon"], answer: 0, why: "It is." },
      { q: "By text", options: ["a", "b"], answer: 1, why: null },
    ]);
    expect(skipped).toBe(4);
  });

  it("rejects single-option, blank-option and non-scalar-option questions", () => {
    expect(parseQuestion({ q: "One", options: ["a"], answer: 0 })).toBeNull();
    expect(parseQuestion({ q: "Blank", options: ["a", " "], answer: 0 })).toBeNull();
    expect(parseQuestion({ q: "Nested", options: ["a", ["b"]], answer: 0 })).toBeNull();
  });

  it("reads numbers as option text and treats a blank why as absent", () => {
    expect(parseQuestion({ q: "2 + 2?", options: [3, 4], answer: 1, why: "  " })).toEqual({
      q: "2 + 2?",
      options: ["3", "4"],
      answer: 1,
      why: null,
    });
  });

  it("tolerates a missing list", () => {
    expect(parseQuestions(undefined)).toEqual({ questions: [], skipped: 0 });
  });
});

describe("quizScore", () => {
  const { questions } = parseQuestions([
    { q: "A", options: ["x", "y"], answer: 0 },
    { q: "B", options: ["x", "y"], answer: 1 },
    { q: "C", options: ["x", "y"], answer: 1 },
  ]);

  it("counts matching picks; unanswered questions are not correct", () => {
    expect(quizScore(questions, [0, 1, 1])).toBe(3);
    expect(quizScore(questions, [0, 0, null])).toBe(1);
    expect(quizScore(questions, [])).toBe(0);
  });
});

describe("parseCards", () => {
  it("keeps cards with a front and drops the rest", () => {
    expect(
      parseCards([{ front: "Hola", back: "Hello" }, { front: " ", back: "x" }, 7, { front: "Solo" }]),
    ).toEqual([
      { front: "Hola", back: "Hello" },
      { front: "Solo", back: "" },
    ]);
  });
});

describe("card order", () => {
  it("follows a growing or shrinking card list", () => {
    expect(reconcileOrder([], 3)).toEqual([0, 1, 2]);
    expect(reconcileOrder([2, 0, 1], 5)).toEqual([2, 0, 1, 3, 4]);
    expect(reconcileOrder([2, 0, 1], 2)).toEqual([0, 1]);
    expect(reconcileOrder([1, 1, 0], 2)).toEqual([1, 0]);
  });

  it("shuffles into a permutation that differs from the current order", () => {
    const order = [0, 1, 2, 3, 4];
    for (let seed = 0; seed < 20; seed++) {
      const shuffled = shuffleOrder(order);
      expect([...shuffled].sort()).toEqual(order);
      expect(shuffled).not.toEqual(order);
    }
    // A random source that always keeps the order still changes something.
    expect(shuffleOrder([0, 1, 2], () => 0.999)).not.toEqual([0, 1, 2]);
    expect(shuffleOrder([0])).toEqual([0]);
  });
});
