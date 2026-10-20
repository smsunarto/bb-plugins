import { expect, test } from "bun:test";
import { ago } from "./time.ts";

test("recent moments read relative and older ones fall back to a date", () => {
  const now = Date.UTC(2026, 9, 20, 12);
  expect(ago(now - 20_000, now)).toBe("just now");
  expect(ago(now - 5 * 60_000, now)).toMatch(/5 min/);
  expect(ago(now - 3 * 3_600_000, now)).toMatch(/3 h/);
  expect(ago(now - 26 * 3_600_000, now)).toMatch(/yesterday|1 day/);
  expect(ago(now - 30 * 86_400_000, now)).toBe(
    new Date(now - 30 * 86_400_000).toLocaleDateString(),
  );
});
