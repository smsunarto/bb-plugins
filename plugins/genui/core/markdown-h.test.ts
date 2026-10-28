import { describe, expect, it } from "vitest";
import { compile, dataKey, evaluate, formatDiagnostics, initialState, parseDataFile, toMarkdown } from "./index";

function markdown(source: string, files: Record<string, string> = {}): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  const data = new Map(Object.entries(files).map(([path, text]) => [dataKey({ path, raw: false }), parseDataFile(path, text)]));
  return toMarkdown(evaluate(result.program, initialState(result.program, data), data).roots);
}

describe("toMarkdown: reports", () => {
  it("renders Tests as one summary line and the failures with their stripped, shortened messages", () => {
    const junit = `<testsuites><testsuite name="api">
<testcase classname="tests.test_api" name="test_list" time="0.004"/>
<testcase classname="tests.test_api" name="test_create" time="0.031"><failure message="assert 201 == 400">E   assert 201 == 400
${Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n")}
tests/test_api.py:22: AssertionError</failure></testcase>
<testcase classname="tests.test_db" name="test_migrate"><error message="no database"/></testcase>
<testcase classname="tests.test_db" name="test_vacuum"><skipped message="needs postgres"/></testcase>
</testsuite></testsuites>`;
    expect(markdown(`Tests(Load("junit.xml"), "API suite")`, { "junit.xml": junit })).toBe(`**API suite** — 🔴 2 failed · 🟢 1 passed · ⚪ 1 skipped · 35 ms

Failures:
1. **test\\_create** — \`tests/test_api.py:22\`
   \`\`\`
   E   assert 201 == 400
   line 0
   line 1
   line 2
   line 3
   line 4
   line 5
   line 6
   line 7
   line 8
   line 9
   line 10
   …
   \`\`\`
2. **test\\_migrate** (error)
   \`\`\`
   no database
   \`\`\``);
  });

  it("strips ANSI codes, shortens absolute paths, and counts the failures it leaves out", () => {
    const failures = Array.from({ length: 22 }, (_, i) => `{name: "t${i}", status: "failed", file: "/repo/src/a.test.ts", line: ${i + 1}}`);
    const out = markdown(`Tests([{name: "x", status: "fail", file: "/repo/core/b.test.ts", message: "\\u001b[31mboom\\u001b[39m"}, ${failures.join(", ")}])`);
    expect(out).toContain("1. **x** — `core/b.test.ts`\n   ```\n   boom\n   ```");
    expect(out).toContain("20. **t18** — `src/a.test.ts:19`");
    expect(out.endsWith("…and 3 more failures")).toBe(true);
    expect(markdown(`Tests([{name: "ok", status: "passed"}])`)).toBe("🟢 1 passed");
    expect(markdown(`Tests([])`)).toBe("No tests ran.");
    expect(markdown(`Tests("nope")`)).toBe("_(Tests needs a list of {name, status}, a vitest/jest JSON report or a JUnit XML report)_");
  });

  it("renders Json as a pretty-printed fence, truncated with a note", () => {
    expect(markdown(`Json({id: 7, tags: ["a"]}, "user")`)).toBe('**user**\n\n```json\n{\n  "id": 7,\n  "tags": [\n    "a"\n  ]\n}\n```');
    const long = markdown(`Json(Load("n.json"))`, { "n.json": JSON.stringify(Array.from({ length: 100 }, (_, i) => i + 1)) });
    expect(long).toContain('```json\n[\n  1,\n  2,');
    expect(long).toContain("  59,\n…\n```");
    expect(long.endsWith("_(first 60 of 102 lines)_")).toBe(true);
  });
});
