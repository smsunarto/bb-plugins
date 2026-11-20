import { describe, expect, test } from "vitest";
import {
  cronProblem,
  describeSchedule,
  expandCronField,
  routineFieldsSchema,
  scheduleSchema,
} from "./routines.ts";

describe("cron limits", () => {
  test.each([
    ["0 9 * * 1-5"],
    ["*/15 * * * *"],
    ["0,30 * * * *"],
    ["0 */2 * * *"],
    ["45 23 * * *"],
    ["0 9 1 * *"],
    ["0 10 * * MON"],
  ])("accepts %s", (cron) => {
    expect(cronProblem(cron)).toBeNull();
  });

  test.each([
    ["* * * * *", "1 minutes apart"],
    ["*/5 * * * *", "5 minutes apart"],
    ["0,10 9 * * *", "10 minutes apart"],
    // 9:50 to 10:00 is ten minutes, across the hour.
    ["0,50 * * * *", "10 minutes apart"],
    ["0,50 9,10 * * *", "10 minutes apart"],
    ["0 9 * *", "five fields"],
    ["x 9 * * *", "minute field"],
    ["0 25 * * *", "hour field"],
    ["0 9 * * 1;2", "weekday field"],
  ])("refuses %s", (cron, message) => {
    expect(cronProblem(cron)).toContain(message);
  });

  test("a gap across the hour counts only when the next hour also runs", () => {
    expect(cronProblem("0,50 9 * * *")).toBeNull();
  });

  test("fields expand ranges, steps and lists", () => {
    expect(expandCronField("1-5", 0, 6)).toEqual([1, 2, 3, 4, 5]);
    expect(expandCronField("5/20", 0, 59)).toEqual([5, 25, 45]);
    expect(expandCronField("0,30,15", 0, 59)).toEqual([0, 15, 30]);
    expect(expandCronField("60", 0, 59)).toBeNull();
  });
});

describe("schedule schema", () => {
  test("a cron needs a known time zone", () => {
    expect(scheduleSchema.safeParse({ cron: "0 9 * * *", timezone: "Europe/Berlin" }).success).toBe(
      true,
    );
    const bad = scheduleSchema.safeParse({ cron: "0 9 * * *", timezone: "Mars/Olympus" });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("unknown time zone");
  });

  test("a cron too frequent is refused; a one-shot has no interval", () => {
    expect(scheduleSchema.safeParse({ cron: "*/5 * * * *", timezone: "UTC" }).success).toBe(false);
    expect(scheduleSchema.safeParse({ at: 1_900_000_000_000 }).success).toBe(true);
  });

  test("spacing in a cron is normalised", () => {
    expect(scheduleSchema.parse({ cron: " 0  9 * *  1-5 ", timezone: "UTC" })).toEqual({
      cron: "0 9 * * 1-5",
      timezone: "UTC",
    });
  });

  test("names and instructions keep their limits", () => {
    const base = { instruction: "Sweep", schedule: { at: 1_900_000_000_000 } };
    expect(routineFieldsSchema.safeParse({ ...base, name: "x".repeat(80) }).success).toBe(true);
    expect(routineFieldsSchema.safeParse({ ...base, name: "x".repeat(81) }).success).toBe(false);
    expect(routineFieldsSchema.safeParse({ ...base, name: "two\nlines" }).success).toBe(false);
    expect(
      routineFieldsSchema.safeParse({ ...base, name: "n", instruction: "x".repeat(4001) }).success,
    ).toBe(false);
  });
});

describe("describeSchedule", () => {
  const words = (cron: string) => describeSchedule({ cron, timezone: "UTC" });

  test.each([
    ["0 9 * * *", "Every day at 9:00 AM"],
    ["30 16 * * *", "Every day at 4:30 PM"],
    ["0 9 * * 1-5", "Every weekday at 9:00 AM"],
    ["0 10 * * 1", "Every Monday at 10:00 AM"],
    ["0 16 * * 5", "Every Friday at 4:00 PM"],
    ["0 0 * * 1,3", "Every Monday and Wednesday at 12:00 AM"],
    ["0 12 * * 0,6", "Every weekend day at 12:00 PM"],
    ["0 * * * *", "Every hour"],
    ["15 * * * *", "Every hour at :15"],
    ["0 */2 * * *", "Every 2 hours"],
    ["*/30 * * * *", "Every 30 minutes"],
    ["0 9 1 * *", "Monthly on the 1st at 9:00 AM"],
    ["0 9 22 * *", "Monthly on the 22nd at 9:00 AM"],
    ["0 9 * 1 *", "Custom schedule (0 9 * 1 *)"],
    ["0 9,17 * * *", "Custom schedule (0 9,17 * * *)"],
  ])("%s reads %s", (cron, expected) => {
    expect(words(cron)).toBe(expected);
  });

  test("a one-shot reads as its time in the zone", () => {
    expect(describeSchedule({ at: Date.UTC(2026, 10, 20, 14, 5) }, "UTC")).toBe(
      "Once, Nov 20, 2026, 2:05 PM",
    );
  });
});
