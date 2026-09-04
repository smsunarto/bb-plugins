import { describe, expect, test } from "bun:test";
import type { EvalCase } from "./lib/cases.ts";
import { directiveKey, scoreRun } from "./lib/criteria.ts";
import { lastProseLine, scanDirectives } from "./lib/directives.ts";
import { newSideRanges, overlaps } from "./lib/hunks.ts";

const NONE = new Map<string, boolean>();

function makeCase(overrides: Partial<EvalCase>): EvalCase {
  return {
    id: "sample",
    kind: "range",
    project: "sample",
    prompt: "do the thing",
    expectDiffFor: ["src/a.ts"],
    noDiffFor: [],
    rangeRequiredFor: [],
    anchorSymbols: ["doThing"],
    ...overrides,
  };
}

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -40,0 +41,3 @@
+one
+two
+three
@@ -90,2 +94,0 @@
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,0 +2,1 @@
+drifted
`;

describe("scanDirectives", () => {
  test("reads a leaf directive with a range", () => {
    const scan = scanDirectives(`intro\n::smart-diff{path="src/a.ts" start="41" end="43"}\n`);
    expect(scan.hidden).toBe(0);
    expect(scan.directives).toHaveLength(1);
    expect(scan.directives[0]).toMatchObject({
      kind: "diff",
      path: "src/a.ts",
      start: 41,
      end: 43,
    });
  });

  test("counts a fenced directive as hidden, never as an embed", () => {
    const scan = scanDirectives('a\n```md\n::smart-diff{path="src/a.ts"}\n```\nb\n');
    expect(scan.directives).toHaveLength(0);
    expect(scan.hidden).toBe(1);
  });

  test("counts an inline directive as hidden", () => {
    const scan = scanDirectives('write `::smart-diff{path="src/a.ts"}` on its own line\n');
    expect(scan.directives).toHaveLength(0);
    expect(scan.hidden).toBe(1);
  });

  test("finds the last prose line past a trailing directive block", () => {
    const text = 'the claim\n\n::smart-diff{path="src/a.ts"}\n::smart-code{path="src/b.ts"}\n';
    expect(lastProseLine(text)).toBe(0);
  });
});

describe("newSideRanges", () => {
  test("maps hunks to new-side ranges per file", () => {
    const ranges = newSideRanges(DIFF);
    expect(ranges.get("src/a.ts")).toEqual([
      { start: 41, end: 43 },
      { start: 94, end: 94 },
    ]);
    expect(ranges.get("src/b.ts")).toEqual([{ start: 2, end: 2 }]);
  });

  test("overlap is inclusive at the edges", () => {
    expect(overlaps({ start: 43, end: 60 }, [{ start: 41, end: 43 }])).toBe(true);
    expect(overlaps({ start: 44, end: 60 }, [{ start: 41, end: 43 }])).toBe(false);
  });
});

describe("necessity", () => {
  test("fails a smart-diff on a file the prompt never named", () => {
    const result = scoreRun(
      makeCase({ noDiffFor: ["src/b.ts"] }),
      {
        caseId: "sample",
        rep: 1,
        timedOut: false,
        response:
          'I changed doThing in src/a.ts.\n::smart-diff{path="src/a.ts"}\n\nsrc/b.ts also looks dirty.\n::smart-diff{path="src/b.ts"}\n',
        diff: DIFF,
      },
      NONE,
    );
    expect(result.necessity).toBe(false);
    expect(result.pass).toBe(false);
  });

  test("fails any smart-diff in a read-only request", () => {
    const result = scoreRun(
      makeCase({ expectDiffFor: [], noDiffFor: "*" }),
      {
        caseId: "sample",
        rep: 1,
        timedOut: false,
        response: 'doThing evicts here.\n::smart-diff{path="src/a.ts"}\n',
        diff: DIFF,
      },
      NONE,
    );
    expect(result.necessity).toBe(false);
  });

  test("passes a read-only request answered with a citation", () => {
    const result = scoreRun(
      makeCase({ expectDiffFor: [], noDiffFor: "*" }),
      {
        caseId: "sample",
        rep: 1,
        timedOut: false,
        response: 'doThing evicts here.\n::smart-code{path="src/a.ts" start="41" end="43"}\n',
        diff: "",
      },
      NONE,
    );
    expect(result.necessity).toBe(true);
    expect(result.coverage).toBe(true);
    expect(result.pass).toBe(true);
  });

  test("fails a smart-diff on a file the run never changed", () => {
    const result = scoreRun(
      makeCase({ expectDiffFor: [] }),
      {
        caseId: "sample",
        rep: 1,
        timedOut: false,
        response: 'doThing lives here.\n::smart-diff{path="src/z.ts"}\n',
        diff: DIFF,
      },
      NONE,
    );
    expect(result.necessity).toBe(false);
  });
});

describe("range-fits", () => {
  test("fails a whole-file diff where a range was required", () => {
    const result = scoreRun(
      makeCase({ rangeRequiredFor: ["src/a.ts"] }),
      {
        caseId: "sample",
        rep: 1,
        timedOut: false,
        response: 'I fixed doThing.\n::smart-diff{path="src/a.ts"}\n',
        diff: DIFF,
      },
      NONE,
    );
    expect(result.rangeFits).toBe(false);
  });

  test("fails a range that misses every changed hunk", () => {
    const result = scoreRun(
      makeCase({ rangeRequiredFor: ["src/a.ts"] }),
      {
        caseId: "sample",
        rep: 1,
        timedOut: false,
        response: 'I fixed doThing.\n::smart-diff{path="src/a.ts" start="200" end="210"}\n',
        diff: DIFF,
      },
      NONE,
    );
    expect(result.rangeFits).toBe(false);
  });

  test("fails a range wider than the cap", () => {
    const result = scoreRun(
      makeCase({ rangeRequiredFor: ["src/a.ts"] }),
      {
        caseId: "sample",
        rep: 1,
        timedOut: false,
        response: 'I fixed doThing.\n::smart-diff{path="src/a.ts" start="1" end="120"}\n',
        diff: DIFF,
      },
      NONE,
    );
    expect(result.rangeFits).toBe(false);
  });

  test("passes a range overlapping a real hunk", () => {
    const result = scoreRun(
      makeCase({ rangeRequiredFor: ["src/a.ts"] }),
      {
        caseId: "sample",
        rep: 1,
        timedOut: false,
        response: 'I fixed doThing.\n::smart-diff{path="src/a.ts" start="38" end="46"}\n',
        diff: DIFF,
      },
      NONE,
    );
    expect(result.rangeFits).toBe(true);
    expect(result.pass).toBe(true);
  });
});

describe("placement", () => {
  test("passes a one-paragraph answer whose embed follows its only claim", () => {
    const result = scoreRun(
      makeCase({ expectDiffFor: ["src/a.ts"] }),
      {
        caseId: "sample",
        rep: 1,
        timedOut: false,
        response: 'I fixed doThing in src/a.ts.\n\n::smart-diff{path="src/a.ts"}\n',
        diff: DIFF,
      },
      NONE,
    );
    expect(result.placement).toBe(true);
  });

  test("fails a multi-paragraph answer that parks its only embed at the bottom", () => {
    const result = scoreRun(
      makeCase({ expectDiffFor: ["src/a.ts"] }),
      {
        caseId: "sample",
        rep: 1,
        timedOut: false,
        response:
          'doThing was truncating.\n\nI switched it to round half up in src/a.ts.\n\n::smart-diff{path="src/a.ts"}\n',
        diff: DIFF,
      },
      NONE,
    );
    expect(result.placement).toBe(false);
  });

  test("fails when two embeds are dumped past the last prose line", () => {
    const result = scoreRun(
      makeCase({ expectDiffFor: [] }),
      {
        caseId: "sample",
        rep: 1,
        timedOut: false,
        response:
          'I fixed doThing in src/a.ts and touched src/b.ts.\n\n::smart-diff{path="src/a.ts"}\n::smart-diff{path="src/b.ts"}\n',
        diff: DIFF,
      },
      NONE,
    );
    expect(result.placement).toBe(false);
  });

  test("fails when nothing near the embed names its file or symbol", () => {
    const result = scoreRun(
      makeCase({ expectDiffFor: [] }),
      {
        caseId: "sample",
        rep: 1,
        timedOut: false,
        response:
          'Here is a summary.\n\nNothing relevant here.\n::smart-diff{path="src/a.ts"}\n\nMore prose.\n',
        diff: DIFF,
      },
      NONE,
    );
    expect(result.placement).toBe(false);
  });

  test("honours a judge rejection even when the proxy holds", () => {
    const response = 'I fixed doThing in src/a.ts.\n::smart-diff{path="src/a.ts"}\n\nDone.\n';
    const directive = scanDirectives(response).directives[0]!;
    const result = scoreRun(
      makeCase({ expectDiffFor: [] }),
      { caseId: "sample", rep: 1, timedOut: false, response, diff: DIFF },
      new Map([[directiveKey("sample", 1, directive), false]]),
    );
    expect(result.placement).toBe(false);
  });

  test("passes an embed sitting under the sentence that names it", () => {
    const result = scoreRun(
      makeCase({ expectDiffFor: ["src/a.ts"] }),
      {
        caseId: "sample",
        rep: 1,
        timedOut: false,
        response: 'I fixed doThing in src/a.ts.\n::smart-diff{path="src/a.ts"}\n\nDone.\n',
        diff: DIFF,
      },
      NONE,
    );
    expect(result.placement).toBe(true);
    expect(result.pass).toBe(true);
  });
});

describe("gates", () => {
  test("coverage fails when an expected embed is missing", () => {
    const result = scoreRun(
      makeCase({}),
      { caseId: "sample", rep: 1, timedOut: false, response: "I fixed it.\n", diff: DIFF },
      NONE,
    );
    expect(result.coverage).toBe(false);
  });

  test("budget fails past six embeds", () => {
    const body = Array.from(
      { length: 7 },
      () => 'doThing in src/a.ts\n::smart-diff{path="src/a.ts" start="41" end="43"}',
    ).join("\n\n");
    const result = scoreRun(
      makeCase({}),
      { caseId: "sample", rep: 1, timedOut: false, response: `${body}\n`, diff: DIFF },
      NONE,
    );
    expect(result.budget).toBe(false);
  });

  test("a timeout is a failed run, never a silent pass", () => {
    const result = scoreRun(
      makeCase({}),
      { caseId: "sample", rep: 1, timedOut: true, response: "", diff: "" },
      NONE,
    );
    expect(result.pass).toBe(false);
    expect(result.coverage).toBe(false);
  });
});
