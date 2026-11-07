import { describe, expect, test } from "bun:test";
import { overflowingProviders, type Rule } from "./rules.ts";

const rule = (instructions: string, providers: string[] = [], enabled = true): Rule => ({
  id: `rule_${providers.join("_")}_${instructions.length}`,
  name: "",
  enabled,
  instructions,
  when: { hosts: [], providers, models: [], projects: [] },
});

describe("overflowingProviders", () => {
  test("adds unscoped rules to each provider's own rules", () => {
    const shared = rule("s".repeat(16000));
    expect(
      overflowingProviders([
        shared,
        rule("c".repeat(16800), ["codex"]),
        rule("x".repeat(100), ["claude-code"]),
      ]),
    ).toEqual([{ provider: "codex", characters: 16000 + 2 + 16800 }]);
  });
  test("reports every provider once when unscoped rules alone overflow", () => {
    expect(
      overflowingProviders([rule("a".repeat(24000)), rule("b".repeat(9600)), rule("c", ["codex"])]),
    ).toEqual([{ provider: null, characters: 33602 }]);
  });
  test("ignores disabled and blank rules", () => {
    expect(
      overflowingProviders([
        rule("a".repeat(32000)),
        rule("b".repeat(32000), [], false),
        rule("   "),
      ]),
    ).toEqual([]);
  });
});
