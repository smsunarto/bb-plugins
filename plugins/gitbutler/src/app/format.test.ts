import { expect, test } from "bun:test";
import { body, changeSymbol, relativeTime, shortId, subject } from "./format.ts";

test("subject and body split a commit message at the first blank line", () => {
  const message = "feat(top): add the thing\n\nWith a body.\nAnd more.";
  expect(subject(message)).toBe("feat(top): add the thing");
  expect(body(message)).toBe("With a body.\nAnd more.");
});

test("a one-line commit message has no body", () => {
  expect(subject("fix: one line")).toBe("fix: one line");
  expect(body("fix: one line")).toBe("");
});

test("shortId takes the usual seven characters", () => {
  expect(shortId("8f4598a1eaca7d3d7080a6756164040f0707d0d5")).toBe("8f4598a");
});

test("relativeTime counts back from a fixed now", () => {
  const now = Date.parse("2026-09-22T12:00:00Z");
  expect(relativeTime("2026-09-22T11:59:30Z", now)).toBe("just now");
  expect(relativeTime("2026-09-22T11:30:00Z", now)).toBe("30m ago");
  expect(relativeTime("2026-09-22T06:00:00Z", now)).toBe("6h ago");
  expect(relativeTime("2026-09-19T12:00:00Z", now)).toBe("3d ago");
});

test("relativeTime is blank for a date the CLI did not supply", () => {
  expect(relativeTime("")).toBe("");
});

test("changeSymbol labels each change kind", () => {
  expect(changeSymbol("added")).toBe("A");
  expect(changeSymbol("deleted")).toBe("D");
  expect(changeSymbol("renamed")).toBe("R");
  expect(changeSymbol("modified")).toBe("M");
});
