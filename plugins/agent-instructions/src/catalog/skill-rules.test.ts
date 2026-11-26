import { describe, expect, test } from "bun:test";
import { parseFrontmatter, pathProblems, SKILL_NAME_PATTERN } from "./skill-rules.ts";

describe("skill names follow bb's contract", () => {
  test.each(["dev", "principle-grug-brain", "a", "x9", "a".repeat(64)])("accepts %s", (name) =>
    expect(SKILL_NAME_PATTERN.test(name)).toBe(true),
  );
  test.each(["-dev", "dev-", "my--skill", "Dev", "dev_x", "", "a".repeat(65)])(
    "rejects %s",
    (name) => expect(SKILL_NAME_PATTERN.test(name)).toBe(false),
  );
});

describe("parseFrontmatter", () => {
  test("reads a folded multi-line description", () => {
    expect(
      parseFrontmatter("---\nname: evals\ndescription: >\n  Run evals.\n  Twice.\n---\nBody"),
    ).toEqual({
      name: "evals",
      description: "Run evals. Twice.\n",
    });
  });
  test("explains why bb would skip a skill", () => {
    expect(parseFrontmatter("# no frontmatter")).toEqual({
      error: "SKILL.md has no YAML frontmatter",
    });
    expect(parseFrontmatter("---\nname: Bad\ndescription: x\n---\n")).toHaveProperty("error");
    expect(
      parseFrontmatter(`---\nname: ok\ndescription: ${"x".repeat(1025)}\n---\n`),
    ).toHaveProperty("error");
  });
});

describe("pathProblems", () => {
  const siblings = new Set(["dev", "principle-grug-brain"]);
  test("flags install paths, even inside code fences", () => {
    const text = "```sh\n~/.agents/skills/statechart/scripts/statechart SPEC.tla\n```\n";
    expect(pathProblems("SKILL.md", text, siblings)).toEqual([
      "SKILL.md: uses the install path ~/.agents/skills/statechart; refer to it relative to the skill",
    ]);
  });
  test("allows prose about install roots and provider files", () => {
    expect(
      pathProblems(
        "SKILL.md",
        "Pi reads `~/.agents/skills` and `~/.claude/CLAUDE.md`; see ~/.claude/plugins/installed_plugins.json.",
        siblings,
      ),
    ).toEqual([]);
  });
  test("flags a skill path at the end of a sentence", () => {
    expect(pathProblems("SKILL.md", "Run it from $HOME/.agents/plugins/media.", siblings)).toEqual([
      "SKILL.md: uses the install path $HOME/.agents/plugins/media; refer to it relative to the skill",
    ]);
  });
  test("allows links inside the skill and to sibling catalog skills", () => {
    const text =
      "[a](references/a.md) [b](../principle-grug-brain/SKILL.md) [c](https://x.dev) [d](#top)";
    expect(pathProblems("SKILL.md", text, siblings)).toEqual([]);
  });
  test("flags links that leave the skill for anything else", () => {
    expect(pathProblems("references/r.md", "[rt](../../../runtime/README.md)", siblings)).toEqual([
      "references/r.md: links outside the skill folder (../../../runtime/README.md)",
    ]);
    expect(pathProblems("SKILL.md", "[x](../missing/SKILL.md)", siblings)).toHaveLength(1);
  });
  test("checks reference definitions, quoted titles, and parent links", () => {
    expect(
      pathProblems(
        "SKILL.md",
        "[rt][r]\n\n[r]: ../../runtime/README.md\n[q](../../x.md 'title')\n[up](..)\n[^1]: a footnote\n",
        siblings,
      ),
    ).toEqual([
      "SKILL.md: links outside the skill folder (../../runtime/README.md)",
      "SKILL.md: links outside the skill folder (../../x.md)",
      "SKILL.md: links outside the skill folder (..)",
    ]);
  });
  test("allows a link to a sibling skill's folder", () => {
    expect(pathProblems("SKILL.md", "[dev](../dev)", siblings)).toEqual([]);
  });
  test("ignores example links inside code fences", () => {
    expect(pathProblems("SKILL.md", "```md\n[x](../../outside.md)\n```\n", siblings)).toEqual([]);
  });
});
