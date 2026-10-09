import { expect, test } from "bun:test";
import { absoluteTime, plural, relativeTime, shortSha, subject, threadLines } from "./format.ts";

const NOW = Date.parse("2026-10-09T12:00:00Z");

test("relativeTime counts up in the largest whole unit, then falls back to a date", () => {
  expect(relativeTime("2026-10-09T11:59:30Z", NOW)).toBe("just now");
  expect(relativeTime("2026-10-09T11:55:00Z", NOW)).toBe("5m ago");
  expect(relativeTime("2026-10-09T09:00:00Z", NOW)).toBe("3h ago");
  expect(relativeTime("2026-10-07T12:00:00Z", NOW)).toBe("2d ago");
  expect(relativeTime("2026-09-01T12:00:00Z", NOW)).toBe(
    new Date("2026-09-01T12:00:00Z").toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    }),
  );
});

test("relativeTime says nothing for a value it cannot read", () => {
  expect(relativeTime("not a date", NOW)).toBe("");
});

test("absoluteTime spells the moment out in the given locale and zone", () => {
  expect(absoluteTime("2026-10-09T12:00:00Z", "en-US", "UTC")).toBe("Oct 9, 2026, 12:00 PM");
  expect(absoluteTime("nope")).toBe("");
});

test("shortSha keeps the first seven characters", () => {
  expect(shortSha("0123456789abcdef0123456789abcdef01234567")).toBe("0123456");
});

test("plural includes the count and picks the noun form", () => {
  expect(plural(1, "file")).toBe("1 file");
  expect(plural(0, "file")).toBe("0 files");
  expect(plural(3, "reply", "replies")).toBe("3 replies");
});

test("subject is the first line of a commit message", () => {
  expect(subject("fix: the thing\n\nLonger body")).toBe("fix: the thing");
  expect(subject("")).toBe("");
});

test("threadLines names a thread's lines, the base side, and falls back to where it was written", () => {
  expect(
    threadLines({ line: 12, startLine: null, startSide: null, originalLine: 12, side: "RIGHT" }),
  ).toBe("Line 12");
  expect(
    threadLines({ line: 12, startLine: 10, startSide: "RIGHT", originalLine: 12, side: "RIGHT" }),
  ).toBe("Lines 10 to 12");
  expect(
    threadLines({ line: 4, startLine: null, startSide: null, originalLine: 4, side: "LEFT" }),
  ).toBe("Line 4 (base)");
  expect(
    threadLines({ line: null, startLine: null, startSide: null, originalLine: 9, side: "RIGHT" }),
  ).toBe("Line 9");
  expect(
    threadLines({
      line: null,
      startLine: null,
      startSide: null,
      originalLine: null,
      side: "RIGHT",
    }),
  ).toBe("File");
});

test("threadLines names both sides of a range that runs from the base into the head", () => {
  expect(
    threadLines({ line: 12, startLine: 40, startSide: "LEFT", originalLine: 12, side: "RIGHT" }),
  ).toBe("Lines 40 (base) to 12");
  expect(
    threadLines({ line: 10, startLine: 10, startSide: "LEFT", originalLine: 10, side: "RIGHT" }),
  ).toBe("Lines 10 (base) to 10");
});
