import { describe, expect, it } from "vitest";
import { calendarLayout, calendarStats, dayLabel, dayString, parseDay, readDays, weekday } from "./calendarMath";

describe("parseDay and dayString", () => {
  it("round-trips dates, whatever the process time zone", () => {
    for (const date of ["2026-01-01", "2026-03-08", "2026-10-25", "2024-02-29", "1999-12-31"]) {
      expect(dayString(parseDay(date)!)).toBe(date);
    }
    expect(parseDay("1970-01-02")).toBe(1);
  });

  it("rejects dates that do not exist or are not plain yyyy-mm-dd", () => {
    for (const date of ["2026-02-30", "2025-02-29", "2026-13-01", "0050-01-01", "2026-3-8", "2026-03-08T00:00", 20260308]) {
      expect(parseDay(date)).toBeNull();
    }
  });
});

describe("weekday and dayLabel", () => {
  it("names the day the date string says, not a neighbour", () => {
    expect(weekday(parseDay("2026-10-09")!)).toBe(5);
    expect(weekday(parseDay("1969-12-28")!)).toBe(0);
    expect(dayLabel(parseDay("2026-03-04")!)).toBe("Wed, Mar 4, 2026");
  });
});

describe("readDays", () => {
  it("reads an object of dates", () => {
    const { values, dropped } = readDays({ "2026-01-02": 3, "2026-01-03": 0, nope: 1, "2026-01-04": "x" });
    expect([...values]).toEqual([
      [parseDay("2026-01-02"), 3],
      [parseDay("2026-01-03"), 0],
    ]);
    expect(dropped).toBe(2);
  });

  it("reads lists, adds repeated dates, and counts a bare event once", () => {
    const { values } = readDays([
      { date: "2026-01-02", value: 2 },
      { date: "2026-01-02", value: 5 },
      ["2026-01-03", 4],
      { date: "2026-01-04" },
      "2026-01-04",
    ]);
    expect(values.get(parseDay("2026-01-02")!)).toBe(7);
    expect(values.get(parseDay("2026-01-03")!)).toBe(4);
    expect(values.get(parseDay("2026-01-04")!)).toBe(2);
  });

  it("drops an explicit null value and reads nothing from other shapes", () => {
    expect(readDays([{ date: "2026-01-02", value: null }]).dropped).toBe(1);
    expect(readDays("2026-01-02").values.size).toBe(0);
  });
});

describe("calendarLayout", () => {
  it("starts on the Sunday before the first day and covers the last", () => {
    // Thu 2026-01-01 … Sat 2026-01-31: five Sunday-first weeks.
    const layout = calendarLayout(parseDay("2026-01-01")!, parseDay("2026-01-31")!);
    expect(dayString(layout.start)).toBe("2025-12-28");
    expect(layout.weeks).toBe(5);
    expect(layout.months).toEqual([{ week: 0, label: "Jan" }]);
  });

  it("names each month at the column holding its 1st", () => {
    const layout = calendarLayout(parseDay("2026-01-01")!, parseDay("2026-03-31")!);
    expect(layout.months).toEqual([
      { week: 0, label: "Jan" },
      // Feb 1 and Mar 1, 2026 are Sundays: the tops of weeks 5 and 9.
      { week: 5, label: "Feb" },
      { week: 9, label: "Mar" },
    ]);
  });

  it("drops the name of a month the range enters too late to fit", () => {
    const layout = calendarLayout(parseDay("2026-01-27")!, parseDay("2026-03-10")!);
    expect(layout.months.map((month) => month.label)).toEqual(["Feb", "Mar"]);
  });

  it("is one column for a single day", () => {
    const day = parseDay("2026-10-09")!;
    expect(calendarLayout(day, day)).toMatchObject({ weeks: 1, months: [{ week: 0, label: "Oct" }] });
  });
});

describe("calendarStats", () => {
  it("totals without float noise and finds the first peak", () => {
    const values = new Map([
      [parseDay("2026-01-03")!, 0.2],
      [parseDay("2026-01-01")!, 0.1],
      [parseDay("2026-01-02")!, 0],
      [parseDay("2026-01-04")!, 0.2],
    ]);
    expect(calendarStats(values)).toEqual({ total: 0.5, active: 3, peak: { day: parseDay("2026-01-03"), value: 0.2 } });
    expect(calendarStats(new Map()).peak).toBeNull();
  });
});
