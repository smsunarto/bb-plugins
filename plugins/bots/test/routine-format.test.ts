import { describe, expect, it } from "vitest";
import { describeCron, relativeTime } from "../lib/routine-format";

describe("describeCron", () => {
  it.each([
    ["0 9 * * 1-5", "Weekdays at 09:00"],
    ["30 8 * * *", "Every day at 08:30"],
    ["0 9 * * 1", "Every Monday at 09:00"],
    ["0 * * * *", "Every hour"],
    ["15 */2 * * *", "Every 2 hours"],
    ["0 9 1 * *", "Cron 0 9 1 * *"],
    ["0 9", "Enter five cron fields: minute hour day month weekday"],
  ])("%s", (cron, text) => expect(describeCron(cron)).toBe(text));
});

it("formats run times relative to now", () => {
  expect(relativeTime(3 * 3_600_000, 0)).toMatch(/3 hours/);
  expect(relativeTime(0, 10_000)).toBe("just now");
});
