import { describe, expect, test } from "vitest";
import { ASK_OPTION_COLUMNS, optionLabelBlockers } from "./asks.ts";
import { clip, displayWidth } from "./width.ts";

const reasons = (...options: string[]) => optionLabelBlockers(options).map((b) => b.reason);

describe("an ask's option labels", () => {
  test("12 columns is accepted and 13 is refused, naming the option and the limit", () => {
    expect(ASK_OPTION_COLUMNS).toBe(12);
    expect(optionLabelBlockers(["Redis cache!", "  SQLite  "])).toEqual([]);
    expect(optionLabelBlockers(["Redis caches!"])).toEqual([
      {
        reason:
          'option "Redis caches!" is 13 columns; an option is ≤12 columns (wide characters count 2), so the buttons fit on one row',
        fix: 'shorten it to a label, such as "Redis", with no ⭐ or other marker; move the detail into --detail-file',
      },
    ]);
  });

  test("each long option gets its own blocker; surrounding space is not counted", () => {
    expect(reasons("  Redis cache!  ")).toEqual([]);
    expect(reasons("Use the Redis cache", "Use SQLite")).toEqual([
      'option "Use the Redis cache" is 19 columns; an option is ≤12 columns (wide characters count 2), so the buttons fit on one row',
    ]);
  });

  test("emoji and wide East Asian characters count 2; combining marks count 0 extra", () => {
    expect(reasons("🚀".repeat(6))).toEqual([]);
    expect(reasons("🚀".repeat(6) + "x")[0]).toContain("is 13 columns");
    expect(reasons("👨‍👩‍👧‍👦 Ship it!!")).toEqual([]); // ZWJ family is one 2-column grapheme
    expect(reasons("キャッシュを使う")[0]).toContain("is 16 columns");
    expect(reasons("缓存后端")).toEqual([]);
    expect(reasons("Café".normalize("NFD") + " au lait")).toEqual([]);
    expect(reasons("Ｒｅｄｉｓ！！")[0]).toContain("is 14 columns"); // fullwidth
  });

  test("a typed ⭐ or (Recommended) marker counts toward the 12 columns", () => {
    expect(reasons("⭐ Redis")).toEqual([]);
    expect(reasons("⭐ Redis cache")[0]).toContain("is 14 columns");
    expect(reasons("Redis (Recommended)")[0]).toContain("is 19 columns");
  });

  test("a narrow label over 80 UTF-16 units is refused so it stays a valid answer", () => {
    const stacked = `a${"́".repeat(100)}`;
    expect(displayWidth(stacked)).toBe(1);
    expect(reasons(stacked)).toEqual([
      `option ${JSON.stringify(stacked)} is 101 UTF-16 units; an option is at most 80`,
    ]);
  });

  test("the echo is JSON-quoted and cut to a short prefix", () => {
    const [reason] = reasons(`Use "Redis"\nfor the cache; fix: nope ${"x".repeat(100_000)}`);
    expect(reason).toBe(
      'option "Use \\"Redis\\"\\nfor the cac…" is 100037 columns; an option is ≤12 columns (wide characters count 2), so the buttons fit on one row',
    );
  });
});

describe("display width", () => {
  test("clip keeps text that fits and cuts the rest to the column budget, ellipsis included", () => {
    expect(clip("Redis", 24)).toBe("Redis");
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("缓存后端", 4)).toBe("缓…");
    expect(displayWidth(clip("缓存后端缓存后端", 5))).toBeLessThanOrEqual(5);
  });
});
