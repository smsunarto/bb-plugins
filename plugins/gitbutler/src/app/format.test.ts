import { expect, test } from "bun:test";
import { absoluteTime, relativeTime, shortId, squashMessage, subject } from "./format.ts";

test("subject is the first line of a commit message", () => {
  const message = "feat(top): add the thing\n\nWith a body.\nAnd more.";
  expect(subject(message)).toBe("feat(top): add the thing");
});

test("a one-line commit message is all subject", () => {
  expect(subject("fix: one line")).toBe("fix: one line");
});

test("a squash is titled by the oldest commit and lists the later ones, oldest first", () => {
  expect(
    squashMessage([
      "feat(app): add a gap constant",
      "fix(format): say moments ago\n\nFresh commits read oddly.",
      "feat(header): add the GitButler mark",
    ]),
  ).toBe(
    "feat(header): add the GitButler mark\n\n- fix(format): say moments ago\n- feat(app): add a gap constant",
  );
  expect(squashMessage(["feat: only one"])).toBe("feat: only one");
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

test("absoluteTime spells out the date and time", () => {
  // Newer ICU puts a narrow no-break space before "PM".
  const text = absoluteTime("2026-01-02T15:04:00Z", "en-US", "UTC").replace(/\s/gu, " ");
  expect(text).toBe("Jan 2, 2026, 3:04 PM");
});

test("absoluteTime is blank for a date the CLI did not supply", () => {
  expect(absoluteTime("")).toBe("");
});
