import { describe, expect, test } from "bun:test";
import { ANYWHERE, MAX_INSTRUCTIONS_LENGTH, type Rule } from "../shared/rules.ts";
import {
  compareOrdered,
  parseDocFile,
  parseRuleFile,
  sanitizeDocId,
  serializeDocFile,
  serializeRuleFile,
} from "./format.ts";

describe("doc format", () => {
  test("parses plain markdown without frontmatter", () => {
    const parsed = parseDocFile("shared", "# Heading\n\nBody text.\n");
    expect(parsed).toEqual({
      id: "shared",
      name: "shared",
      enabled: true,
      order: undefined,
      body: "# Heading\n\nBody text.\n",
      hasFrontmatter: false,
    });
  });

  test("does not misparse a plain markdown doc starting with a horizontal rule", () => {
    const raw = "---\n\nParagraph after thematic break.\n";
    expect(parseDocFile("notes", raw).body).toBe(raw);
    const nonMeta = "---\nfoo: bar\n---\n\nBody.\n";
    expect(parseDocFile("notes", nonMeta).hasFrontmatter).toBe(false);
    expect(parseDocFile("notes", nonMeta).body).toBe(nonMeta);
  });

  test("round-trips doc frontmatter and arbitrary body whitespace losslessly", () => {
    for (const body of ["", "Plain.", "Trailing newline.\n", "\nLeading newline", "  \n "]) {
      const serialized = serializeDocFile({
        id: "shared",
        name: "Global instructions",
        enabled: false,
        order: 2,
        body,
        hasFrontmatter: true,
      });
      const parsed = parseDocFile("shared", serialized);
      expect(parsed.name).toBe("Global instructions");
      expect(parsed.enabled).toBe(false);
      expect(parsed.order).toBe(2);
      expect(parsed.body).toBe(body);
    }
  });

  test("prevents YAML frontmatter injection when plain doc body begins with --- block", () => {
    const spoofedBody = "---\nname: Spoofed\nenabled: false\n---\n\nBody\n";
    const serialized = serializeDocFile({
      id: "notes",
      name: "notes",
      enabled: true,
      body: spoofedBody,
      hasFrontmatter: false,
    });
    const parsed = parseDocFile("notes", serialized);
    expect(parsed.name).toBe("notes");
    expect(parsed.enabled).toBe(true);
    expect(parsed.body).toBe(spoofedBody);
  });

  test("sanitizes legacy doc ids cleanly", () => {
    expect(sanitizeDocId("imported:shared")).toBe("shared");
    expect(sanitizeDocId("doc_abc123")).toBe("doc_abc123");
    expect(sanitizeDocId("weird:name/with spaces")).toBe("weird-name-with-spaces");
  });
});

describe("rule format", () => {
  test("round-trips scoped, unscoped, empty-name, and whitespace rules losslessly", () => {
    const cases: Rule[] = [
      {
        id: "rule_codex",
        name: "Codex only",
        enabled: true,
        instructions: "Use Codex web tool.",
        when: { hosts: ["host_1"], providers: ["codex"], models: ["gpt-5*"], projects: ["proj_1"] },
      },
      {
        id: "rule_blank_name",
        name: "",
        enabled: false,
        instructions: "  \n ",
        when: { ...ANYWHERE },
      },
      {
        id: "rule_empty_body",
        name: "Empty",
        enabled: true,
        instructions: "",
        when: { ...ANYWHERE },
      },
    ];
    for (let i = 0; i < cases.length; i++) {
      const rule = cases[i]!;
      const serialized = serializeRuleFile(rule, i);
      const parsed = parseRuleFile(rule.id, serialized);
      expect("error" in parsed).toBe(false);
      if (!("error" in parsed)) {
        expect(parsed.rule).toEqual(rule);
        expect(parsed.order).toBe(i);
      }
    }
  });

  test("parses human-authored rule file with minimal frontmatter or none", () => {
    const minimal = parseRuleFile(
      "use-bun",
      "---\nwhen:\n  providers:\n    - codex\n---\n\nAlways use bun.\n",
    );
    expect("error" in minimal).toBe(false);
    if (!("error" in minimal)) {
      expect(minimal.rule).toEqual({
        id: "use-bun",
        name: "use-bun",
        enabled: true,
        instructions: "Always use bun.\n",
        when: { hosts: [], providers: ["codex"], models: [], projects: [] },
      });
    }

    const plain = parseRuleFile("always-on", "Be concise.");
    expect("error" in plain).toBe(false);
    if (!("error" in plain)) {
      expect(plain.rule.when).toEqual(ANYWHERE);
      expect(plain.rule.instructions).toBe("Be concise.");
    }
  });

  test("rejects malformed frontmatter and oversized bodies", () => {
    const badYaml = parseRuleFile("bad", "---\nwhen: [unclosed\n---\nbody");
    expect("error" in badYaml).toBe(true);

    const unknownKey = parseRuleFile("bad2", "---\nunknown: 1\n---\nbody");
    expect("error" in unknownKey).toBe(true);

    const huge = parseRuleFile("huge", "x".repeat(MAX_INSTRUCTIONS_LENGTH + 1));
    expect("error" in huge).toBe(true);
  });

  test("sorts ordered items before unordered ones, then by id", () => {
    const items = [
      { id: "b", order: undefined },
      { id: "a", order: undefined },
      { id: "second", order: 1 },
      { id: "first", order: 0 },
    ].sort(compareOrdered);
    expect(items.map((x) => x.id)).toEqual(["first", "second", "a", "b"]);
  });
});
