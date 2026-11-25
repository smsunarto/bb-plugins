import { describe, expect, test } from "vitest";
import { ASK_OPTION_COLUMNS, askBlockers, optionLabelBlockers } from "./asks.ts";
import { clip, displayWidth } from "./width.ts";

const reasons = (...options: string[]) => optionLabelBlockers(options).map((b) => b.reason);
/** The blockers every ask's options meet, new or rerun, for one option beside "Hold". */
const lineBlockers = (option: string, kind: "decision" | "ship" = "decision") =>
  askBlockers({
    kind,
    taskKey: "BBPLUGINS-1",
    text: "Pick one",
    detail: "d",
    options: [option, "Hold"],
  });

describe("an ask's option labels", () => {
  test("12 columns is accepted and 13 is refused, naming the option and the limit", () => {
    expect(ASK_OPTION_COLUMNS).toBe(12);
    expect(optionLabelBlockers(["Redis cache!", "SQLite"])).toEqual([]);
    expect(optionLabelBlockers(["Redis caches!"])).toEqual([
      {
        reason:
          'option "Redis caches!" is 13 columns; an option is ≤12 columns (wide characters count 2), so the buttons fit on one row',
        fix: 'shorten it to a label, such as "Redis", with no ⭐ or other marker; move the detail into --detail-file',
      },
    ]);
  });

  test("each long option gets its own blocker", () => {
    expect(reasons("Use the Redis cache", "Use SQLite")).toEqual([
      'option "Use the Redis cache" is 19 columns; an option is ≤12 columns (wide characters count 2), so the buttons fit on one row',
    ]);
  });

  test("column checks stop at the ninth option", () => {
    expect(reasons(...Array<string>(8).fill("Keep"), "Ninth is long", "Tenth is long")).toEqual([
      expect.stringContaining('option "Ninth is long"'),
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

  test("keycap emoji count 2 columns", () => {
    expect(displayWidth("1\u{FE0F}\u{20E3}")).toBe(2);
    expect(displayWidth("#\u{20E3}")).toBe(2);
    expect(reasons("1\u{FE0F}\u{20E3}".repeat(6))).toEqual([]);
    expect(reasons("1\u{FE0F}\u{20E3}".repeat(7))[0]).toContain("is 14 columns");
  });

  test("the echo is JSON-quoted and cut to a short prefix", () => {
    const [reason] = reasons(`Use "Redis"\nfor the cache; fix: nope ${"x".repeat(100_000)}`);
    expect(reason).toBe(
      'option "Use \\"Redis\\"\\nfor the cac…" is 100037 columns; an option is ≤12 columns (wide characters count 2), so the buttons fit on one row',
    );
  });

  test("column clipping uses the ellipsis already at the cut", () => {
    const prefix = `${"x".repeat(22)}…`;
    expect(reasons(`${prefix}continued`)[0]).toContain(`option "${prefix}" is`);
  });

  test("the echo escapes terminal and directional controls", () => {
    expect(reasons("Use\u0085\u009b\u2028\u2029\u061c\u202e\u2066Redis cache")[0]).toContain(
      'option "Use\\u0085\\u009b\\u2028\\u2029\\u061c\\u202e\\u2066Redis cache"',
    );
  });
});

describe("the rules every option meets, new or rerun", () => {
  test("over 80 UTF-16 units is refused, so the label stays a valid answer, and the echo stays short", () => {
    const stacked = `a${"\u0301".repeat(100_000)}`;
    expect(displayWidth(stacked)).toBe(1);
    expect(lineBlockers(stacked)).toEqual([
      {
        reason: `option ${JSON.stringify(`${stacked.slice(0, 64)}…`)} is 100001 UTF-16 units; an option is at most 80`,
        fix: "shorten it; move the detail into --detail-file",
      },
    ]);
    expect(JSON.stringify(lineBlockers(stacked)).length).toBeLessThan(500);
    expect(lineBlockers("x".repeat(80))).toEqual([]);
    expect(lineBlockers("x".repeat(81))[0]?.reason).toContain("is 81 UTF-16 units");
  });

  test.each([
    ["keeps a whole code point", "🚀"],
    ["uses an existing ellipsis", "…"],
  ])("the unit cut %s", (_rule, suffix) => {
    const cluster = `a${"\u0301".repeat(62)}`;
    expect(lineBlockers(`${cluster}${suffix}${"x".repeat(20)}`)[0]?.reason).toContain(
      `option "${cluster}…" is`,
    );
  });

  test("an option with a line break is refused", () => {
    expect(lineBlockers("Redis\nnow")).toEqual([
      {
        reason: 'option "Redis\\nnow" spans lines; an option is one line',
        fix: "put it on one line; move the detail into --detail-file",
      },
    ]);
    expect(lineBlockers("Redis\r")).toEqual([]); // trimmed
    expect(lineBlockers("Re\rdis")[0]?.reason).toContain("spans lines");
  });

  test("a ship ask's long option only says to drop it", () => {
    expect(lineBlockers("x".repeat(200), "ship")).toEqual([
      { reason: "a ship ask's options are always Merge and Hold", fix: "drop --option" },
    ]);
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
