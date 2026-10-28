import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  countSeverities,
  editsPatch,
  fixAllMessage,
  fixThisMessage,
  groupByArea,
  groupByFile,
  groupBySeverity,
  hasLifecycle,
  isResolved,
  needsFix,
  readFindings,
  sortFindings,
  statusCounts,
  statusSentence,
  verdictHeadline,
  type Finding,
  type FindingsReport,
} from "./findings";
import type { Value } from "./types";

const fixture = (name: string) => readFileSync(new URL(`../gallery/data/${name}`, import.meta.url), "utf8");
const json = (name: string) => JSON.parse(fixture(name)) as Value;

function report(value: Value): FindingsReport {
  const result = readFindings(value);
  if (!result.ok) throw new Error(result.error);
  return result.report;
}

describe("readFindings: tool output", () => {
  it("reads ESLint JSON: severities, rules with docs, positions, and fixes as patches where the source is included", () => {
    const { tool, scale, findings } = report(json("eslint.json"));
    expect([tool, scale, findings.length]).toEqual(["ESLint", "lint", 11]);
    expect(countSeverities(findings)).toMatchObject({ high: 5, medium: 6 });
    const preferConst = findings.find((item) => item.rule === "prefer-const")!;
    expect(preferConst).toMatchObject({ file: "data/src/mapMath.ts", line: 79, column: 7, url: "https://eslint.org/docs/latest/rules/prefer-const" });
    // mapMath.ts kept its `source`: the fix is a patch.
    expect(preferConst.fix).toEqual({
      kind: "patch",
      patch: [
        "--- a/data/src/mapMath.ts",
        "+++ b/data/src/mapMath.ts",
        "@@ -77,5 +77,5 @@",
        "/** Where `point` sits in the viewport, using its copy of the world nearest the view's centre. */",
        "export function toScreen(point: Point, view: View, size: Size): { readonly left: number; readonly top: number } {",
        "-  let scale = worldSize(view.zoom);",
        "+  const scale = worldSize(view.zoom);",
        "   const dx = point.x - view.x;",
        "   return {",
      ]
        .map((line, index) => (index === 3 || index === 4 ? ` ${line}` : line))
        .join("\n"),
    });
    // json-logic.ts has no `source` in the fixture: a suggestion stays as edits, with ESLint's description.
    const unused = findings.find((item) => item.file === "data/src/json-logic.ts" && item.rule === "@typescript-eslint/no-unused-vars")!;
    expect(unused.fix?.kind).toBe("edits");
    expect(unused.fixNote).toBe("Remove unused import declaration.");
    expect(unused.url).toBe("https://typescript-eslint.io/rules/no-unused-vars");
  });

  it("reads ESLint's json-with-metadata, taking rule docs from the metadata", () => {
    const results = json("eslint.json");
    const { findings } = report({
      results,
      metadata: { rulesMeta: { eqeqeq: { docs: { description: "Require the use of `===` and `!==`", url: "https://example.test/eqeqeq" } } } },
    });
    const eqeqeq = findings.find((item) => item.rule === "eqeqeq")!;
    expect(eqeqeq.url).toBe("https://example.test/eqeqeq");
    expect(eqeqeq.detail).toBe("Require the use of `===` and `!==`");
  });

  it("reads SARIF from eslint-formatter-sarif: levels, rule help links, regions", () => {
    const { tool, findings } = report(json("eslint.sarif"));
    expect(tool).toBe("ESLint");
    expect(findings).toHaveLength(11);
    expect(findings[0]).toMatchObject({
      severity: "medium",
      title: "'readFileSync' is defined but never used.",
      file: "data/src/json-logic.ts",
      line: 6,
      column: 10,
      endColumn: 22,
      rule: "@typescript-eslint/no-unused-vars",
      url: "https://typescript-eslint.io/rules/no-unused-vars",
    });
  });

  it("reads SARIF's security severities, message arguments, base URIs, artifact indexes, snippets and fixes", () => {
    const log = {
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "CodeQL",
              rules: [
                {
                  id: "js/path-injection",
                  helpUri: "https://codeql.github.com/codeql-query-help/javascript/js-path-injection/",
                  help: { markdown: "# Uncontrolled data used in path expression\n\nAccessing paths controlled by users…" },
                  properties: { "security-severity": "7.5" },
                  messageStrings: { default: { text: "This path depends on a {0}." } },
                },
                { id: "js/unused-local-variable", defaultConfiguration: { level: "note" } },
              ],
            },
          },
          originalUriBaseIds: { SRCROOT: { uri: "file:///home/dev/app/" } },
          artifacts: [{ location: { uri: "src/My%20File.ts", uriBaseId: "SRCROOT" } }],
          results: [
            {
              ruleIndex: 0,
              message: { id: "default", arguments: ["[user-provided value](1)"] },
              locations: [{ physicalLocation: { artifactLocation: { index: 0, uriBaseId: "SRCROOT" }, region: { startLine: 3, startColumn: 5, snippet: { text: "readFile(name)" } } } }],
              fixes: [
                {
                  description: { text: "Normalize the path" },
                  artifactChanges: [{ artifactLocation: { index: 0 }, replacements: [{ deletedRegion: { startLine: 3, startColumn: 20, endColumn: 24 }, insertedContent: { text: "safe(name)" } }] }],
                },
              ],
            },
            { ruleId: "js/unused-local-variable", message: { text: "Unused variable x." }, locations: [] },
            { ruleId: "js/unused-local-variable", kind: "pass", message: { text: "fine" } },
            { ruleId: "js/unused-local-variable", message: { text: "suppressed" }, suppressions: [{ kind: "inSource" }] },
          ],
        },
      ],
    } as unknown as Value;
    const { tool, scale, findings } = report(log);
    expect([tool, scale, findings.length]).toEqual(["CodeQL", "risk", 2]);
    const [injection, unused] = findings as [Finding, Finding];
    expect(injection).toMatchObject({
      severity: "high",
      title: "This path depends on a user-provided value.",
      file: "/home/dev/app/src/My File.ts",
      line: 3,
      column: 5,
      snippet: "readFile(name)",
      fixNote: "Normalize the path",
      url: "https://codeql.github.com/codeql-query-help/javascript/js-path-injection/",
    });
    expect(injection.detail).toContain("Uncontrolled data used in path expression");
    expect(injection.fix).toEqual({
      kind: "edits",
      edits: [{ start: { line: 3, column: 20 }, end: { line: 3, column: 24 }, text: "safe(name)" }],
    });
    expect(editsPatch("a\nb\nconst t = readFile(name);\n", "src/My File.ts", injection.fix!.kind === "edits" ? injection.fix!.edits : [])).toContain(
      "+const t = readFile(safe(name));",
    );
    expect(unused).toMatchObject({ severity: "low", file: null, line: null });
  });

  it("reads tsc --pretty false: locations, codes, message chains as text detail, global errors", () => {
    const { tool, findings } = report(fixture("tsc.txt"));
    expect(tool).toBe("tsc");
    expect(findings.map((item) => [item.file, item.line, item.column, item.rule])).toEqual([
      ["data/src/json-logic.ts", 49, 52, "TS2322"],
      ["data/src/json-logic.ts", 51, 31, "TS2551"],
      ["data/src/mapMath.ts", 74, 20, "TS2345"],
    ]);
    expect(findings[2]).toMatchObject({ detail: "Property 'zoom' is missing in type '{ x: number; y: number; }' but required in type 'View'.", detailIsText: true });
    const global = report("error TS5023: Unknown compiler option 'strictt'.\n");
    expect(global.findings[0]).toMatchObject({ file: null, rule: "TS5023", title: "Unknown compiler option 'strictt'." });
  });

  it("reads tsc's pretty output with ANSI colours, Windows paths and unicode, skipping the code frame", () => {
    const pretty = [
      "\x1b[96msrc/übersicht.ts\x1b[0m:\x1b[93m4\x1b[0m:\x1b[93m7\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2322: \x1b[0mType 'string' is not assignable to type 'number'.",
      "",
      "\x1b[7m4\x1b[0m const n: number = \"ñ\";",
      "\x1b[7m \x1b[0m \x1b[91m      ~\x1b[0m",
      "",
      "C:\\work\\app\\src\\a.ts(2,1): warning TS6133: 'x' is declared but its value is never read.",
      "",
      "Found 2 errors in 2 files.",
    ].join("\r\n");
    const { findings } = report(pretty);
    expect(findings.map((item) => [item.file, item.line, item.severity, item.detail])).toEqual([
      ["src/übersicht.ts", 4, "high", null],
      ["C:/work/app/src/a.ts", 2, "medium", null],
    ]);
  });

  it("reads Ruff JSON: codes, docs URLs, fixes as edits with Ruff's message", () => {
    const { tool, findings } = report(json("ruff.json"));
    expect([tool, findings.length]).toEqual(["Ruff", 8]);
    const none = findings.find((item) => item.rule === "E711")!;
    expect(none).toMatchObject({ file: "data/src/durations.py", line: 34, column: 16, endColumn: 20, fixNote: "Replace with `cond is None`", url: "https://docs.astral.sh/ruff/rules/none-comparison" });
    expect(editsPatch(fixture("src/durations.py"), "data/src/durations.py", none.fix!.kind === "edits" ? none.fix!.edits : [])).toBe(
      [
        "--- a/data/src/durations.py",
        "+++ b/data/src/durations.py",
        "@@ -32,5 +32,5 @@",
        " ",
        " def read_status(word: Optional[str], aliases={}) -> Optional[str]:",
        "-    if word == None:",
        "+    if word is None:",
        "         return None",
        "     word = word.strip().lower()",
      ].join("\n"),
    );
    // Removing a whole line (`import os`) deletes it, adds nothing.
    const os = findings.find((item) => item.rule === "F401")!;
    const patch = editsPatch(fixture("src/durations.py"), "x.py", os.fix!.kind === "edits" ? os.fix!.edits : [])!;
    expect(patch).toContain("@@ -1,4 +1,3 @@\n \"\"\"Test-run summaries");
    expect(patch).toContain("-import os\n import json");
  });

  it("reads oxlint and Biome JSON", () => {
    const ox = report(json("oxlint.json"));
    expect([ox.tool, ox.findings.length]).toEqual(["oxlint", 8]);
    expect(ox.findings[0]).toMatchObject({ rule: "eslint(no-unused-vars)", line: 66, column: 9, endColumn: 14, detail: "Consider removing this declaration." });
    const biome = report(json("biome.json"));
    expect([biome.tool, biome.findings.length]).toEqual(["Biome", 11]);
    expect(biome.findings[0]).toMatchObject({ rule: "noExplicitAny", url: "https://biomejs.dev/linter/rules/no-explicit-any/", file: "data/src/json-logic.ts", line: 43 });
  });
});

describe("readFindings: lists and edge cases", () => {
  it("reads hand-written items: severity words, locations in the file field, patches vs code fixes, the risk scale", () => {
    const { scale, findings, ignored } = report([
      { severity: "High", title: "SQL built from input", file: "api/users.ts:41:7", fix: "--- a/api/users.ts\n+++ b/api/users.ts\n@@ -41 +41 @@\n-a\n+b" },
      { severity: "nit", message: "Name it plural", path: "api/list.ts", line: 3, fix: "const users = []" },
      { title: "" },
      "Bare string finding",
    ]);
    expect(scale).toBe("risk");
    expect(ignored).toBe(1);
    expect(findings.map((item) => [item.severity, item.title, item.file, item.line, item.column, item.fix?.kind ?? null])).toEqual([
      ["high", "SQL built from input", "api/users.ts", 41, 7, "patch"],
      ["medium", "Name it plural", "api/list.ts", 3, null, "code"],
      ["medium", "Bare string finding", null, null, null, null],
    ]);
    expect(report([{ severity: "warning", title: "w" }]).scale).toBe("lint");
  });

  it("answers empty reports and refuses shapes it can't read", () => {
    expect(report([]).findings).toEqual([]);
    expect(report("").findings).toEqual([]);
    expect(report({ runs: [] }).findings).toEqual([]);
    expect(readFindings("just some text").ok).toBe(false);
    expect(readFindings(42).ok).toBe(false);
    expect(readFindings([{ nope: 1 }]).ok).toBe(false);
  });

  it("reads a thousand ESLint messages without trouble", () => {
    const messages = Array.from({ length: 1000 }, (_, index) => ({ ruleId: "no-console", severity: index % 2 === 0 ? 2 : 1, message: `m${index}`, line: index + 1, column: 1 }));
    const { findings } = report([{ filePath: "/repo/src/big.ts", messages }] as unknown as Value);
    expect(findings).toHaveLength(1000);
    expect(groupByFile(findings)[0]!.findings[0]!.severity).toBe("high");
  });
});

describe("grouping and messages", () => {
  const items = report([
    { severity: "low", title: "c", file: "b.ts", line: 9 },
    { severity: "critical", title: "a", file: "b.ts", line: 30 },
    { severity: "medium", title: "b", file: "a.ts", line: 2 },
    { severity: "medium", title: "d", file: "a.ts", line: 1 },
    { severity: "info", title: "e" },
  ]).findings;

  it("groups by file, the most severe file first, each file most severe first then by line", () => {
    expect(groupByFile(items).map((group) => [group.file, group.findings.map((item) => item.title).join("")])).toEqual([
      ["b.ts", "ac"],
      ["a.ts", "db"],
      [null, "e"],
    ]);
  });

  it("groups by severity", () => {
    expect(groupBySeverity(items).map((group) => [group.severity, group.findings.length])).toEqual([
      ["critical", 1],
      ["medium", 2],
      ["low", 1],
      ["info", 1],
    ]);
  });

  it("writes Fix this and Fix all", () => {
    const eslint = report(json("eslint.json")).findings;
    const eqeqeq = eslint.find((item) => item.rule === "eqeqeq" && item.file === "data/src/mapMath.ts")!;
    expect(fixThisMessage(eqeqeq)).toBe("Fix Expected '===' and instead saw '==' (eqeqeq) at data/src/mapMath.ts:72");
    const all = fixAllMessage(eslint, "lint");
    expect(all.split("\n")[0]).toBe("Fix all 11 findings (5 errors, 6 warnings):");
    expect(all.split("\n")).toHaveLength(12);
    const many = Array.from({ length: 45 }, (_, index) => items[index % items.length]!);
    expect(fixAllMessage(many, "risk").split("\n").at(-1)).toBe("… and 5 more");
  });
});

describe("editsPatch", () => {
  it("joins nearby edits in one hunk and keeps far ones apart", () => {
    const source = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    const patch = editsPatch(source, "f.txt", [
      { start: { line: 2, column: 1 }, end: { line: 2, column: 5 }, text: "LINE" },
      { start: { line: 4, column: 1 }, end: { line: 4, column: 5 }, text: "LINE" },
      { start: { line: 25, column: 6 }, end: { line: 25, column: 8 }, text: "XXV" },
    ])!;
    expect(patch.match(/^@@/gm)).toHaveLength(2);
    expect(patch).toContain("@@ -1,6 +1,6 @@");
    expect(patch).toContain("-line 25\n+line XXV");
  });

  it("refuses edits outside the file or overlapping", () => {
    expect(editsPatch("a\nb", "f", [{ start: { offset: 10 }, end: { offset: 11 }, text: "" }])).toBeNull();
    expect(
      editsPatch("abcdef", "f", [
        { start: { offset: 0 }, end: { offset: 3 }, text: "" },
        { start: { offset: 2 }, end: { offset: 4 }, text: "" },
      ]),
    ).toBeNull();
  });
});

describe("reviews and their lifecycle", () => {
  const coil = report(json("findings-review.json"));

  it("reads the review schema: issue as title, area as rule, P0–P3 as severities, evidence, prose fixes, statuses", () => {
    expect([coil.tool, coil.scale, coil.findings.length]).toEqual([null, "priority", 5]);
    expect(coil.review).toEqual({
      subject: "Coil",
      verdict: { kind: "fix-required", text: "fix-required" },
      evidence: expect.arrayContaining(["Reduced motion emulated in DevTools; keyboard and touch input exercised"]),
      artifacts: ["review/coil/desktop-1440x900.png", "review/coil/portrait-390x844-reduced-motion.png", "review/coil/paused-trace.json"],
    });
    const particles = coil.findings.find((item) => item.id === "S2")!;
    expect(particles).toMatchObject({
      severity: "high",
      title: "Particles keep moving after reduced motion is turned on mid-game",
      rule: "motion",
      fix: { kind: "proposal", text: "Clear live particles when the reduced-motion preference changes, not only when they spawn." },
      fixNote: null,
      status: "fixed",
      owner: "Coil owner",
      round: "2",
    });
    expect(particles.evidence).toContain("prefers-reduced-motion");
    expect(coil.findings.map((item) => item.status)).toEqual(["deferred", "fixed", "confirmed", "open", "rejected"]);
    expect(coil.findings.find((item) => item.id === "S3")!.by).toBe("reviewer");
  });

  it("maps status words, keeps unknown words open, and leaves findings without a status null", () => {
    const { findings } = report([
      { severity: "p0", title: "a", status: "Won't fix" },
      { severity: "P1", title: "b", status: "resolved" },
      { severity: "P2", title: "c", status: "verified" },
      { severity: "P3", title: "d", status: "out of scope", owner: "kit" },
      { severity: "p4", title: "e", status: "false_positive" },
      { severity: "P2", title: "f", status: "triaged" },
      { severity: "P2", title: "g" },
    ]);
    expect(findings.map((item) => [item.severity, item.status])).toEqual([
      ["critical", "wontfix"],
      ["high", "fixed"],
      ["medium", "confirmed"],
      ["low", "deferred"],
      ["info", "rejected"],
      ["medium", "open"],
      ["medium", null],
    ]);
    // A plain list's `fix` stays code; only review items (issue/area) read it as a proposal.
    expect(report([{ severity: "low", title: "x", fix: "a()" }]).findings[0]!.fix).toEqual({ kind: "code", code: "a()" });
  });

  it("counts statuses, naming a shared owner of deferred findings, and only with a lifecycle", () => {
    expect(statusCounts(coil.findings).map((entry) => entry.text)).toEqual([
      "1 open",
      "1 deferred to shared shell",
      "1 fixed, awaiting confirmation",
      "1 confirmed",
      "1 rejected",
    ]);
    expect(hasLifecycle(coil.findings)).toBe(true);
    expect(statusCounts(report(json("eslint.json")).findings)).toEqual([]);
  });

  it("heads with the verdict and what is still open, toned by what is open rather than by the verdict's word", () => {
    expect(verdictHeadline(coil)).toEqual({ text: "Fix required: 1 P1, 1 P2 open · 1 awaiting confirmation", tone: "bad" });
    const ship = report({ game: "Snake", verdict: "ship", findings: [1, 2, 3, 4, 5].map((n) => ({ severity: "P2", issue: `i${n}`, area: "ui" })) });
    expect(verdictHeadline(ship)).toEqual({ text: "Ship: 5 P2 open", tone: "warn" });
    const shipWithP1 = report({ verdict: "ship", findings: [{ severity: "P1", issue: "x" }] });
    expect(verdictHeadline(shipWithP1)?.tone).toBe("bad");
    const settled = report({ verdict: "Fix_Required", findings: [{ severity: "P1", issue: "x", status: "confirmed" }] });
    expect(verdictHeadline(settled)).toEqual({ text: "Fix required: nothing open", tone: "good" });
    expect(verdictHeadline(report({ verdict: "needs a second look", findings: [] }))?.text).toBe("Needs a second look: nothing open");
    expect(report({ verdict: "ship" }).review?.verdict?.kind).toBe("ship");
    expect(verdictHeadline(report(json("eslint.json")))).toBeNull();
  });

  it("says where a finding stands, and who checked", () => {
    const by = (id: string) => coil.findings.find((item) => item.id === id)!;
    expect(statusSentence(by("S1"))).toBe("Deferred to shared shell · round 2");
    expect(statusSentence(by("S2"))).toBe("Fixed by Coil owner; not yet confirmed by the reviewer · round 2");
    expect(statusSentence(by("S3"))).toBe("Fix confirmed by reviewer · round 2");
    expect(statusSentence(by("S5"))).toBe("Rejected by Coil owner · round 2");
  });

  it("sorts what needs a fix first and settled findings last, and groups by area", () => {
    expect(sortFindings(coil.findings).map((item) => item.id)).toEqual(["S1", "S4", "S2", "S3", "S5"]);
    expect(groupByArea(coil.findings).map((group) => [group.area, group.findings.length])).toEqual([
      ["motion", 1],
      ["shared shell", 1],
      ["input", 1],
      ["layout", 1],
      ["rendering", 1],
    ]);
  });

  it("acts only on findings that still need a fix, naming deferrals and the review", () => {
    const fixable = coil.findings.filter(needsFix);
    expect(fixable.map((item) => item.id)).toEqual(["S1", "S4"]);
    expect(coil.findings.filter((item) => !isResolved(item)).map((item) => item.id)).toEqual(["S1", "S2", "S4"]);
    expect(fixAllMessage(fixable, coil.scale, (item) => item.file, "Coil")).toBe(
      [
        "Fix all 2 open findings from the Coil review (1 P1, 1 P2):",
        "- P1: Pause drawer secondary text fails contrast in the dark theme (shared shell) — deferred to shared shell",
        "- P2: Touch steering target is smaller than 44 px in landscape (input)",
      ].join("\n"),
    );
    expect(fixThisMessage(fixable[1]!)).toBe("Fix Touch steering target is smaller than 44 px in landscape (input)");
  });
});
