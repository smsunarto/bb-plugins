import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  acceptanceVerdict,
  cellsLine,
  checkLabel,
  checkSummary,
  isGap,
  needsPlaces,
  ownerContradiction,
  readAcceptance,
  readEvidence,
  verdictLine,
  type AcceptanceReport,
} from "./acceptance";
import type { Value } from "./types";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../gallery/data/${name}`, import.meta.url), "utf8")) as Value;

function report(value: Value, columns?: Value): AcceptanceReport {
  const result = readAcceptance(value, columns);
  if (!result.ok) throw new Error(result.error);
  return result.report;
}

const line = (value: Value, columns?: Value) => verdictLine(acceptanceVerdict(report(value, columns)));

describe("readAcceptance: one status per criterion", () => {
  it("reads every alias into the five statuses plus skipped, keeping telling spellings", () => {
    const read = report([
      { name: "a", status: "pass" },
      { name: "b", status: "OK" },
      { name: "c", status: "met" },
      { name: "d", status: "verified", by: "reviewer" },
      { name: "e", status: "FAIL" },
      { name: "f", status: "not met" },
      { name: "g", status: "Blocked" },
      { name: "h", status: "not exercised" },
      { name: "i", status: "pending" },
      { name: "j", status: "unknown" },
      { name: "k", status: "n/a" },
      { name: "l", status: "claimed" },
      { name: "m", status: "owner-reported" },
      { name: "n", status: "unverified", by: "builder" },
      { name: "o", status: "skipped" },
      { name: "p", status: "no match" },
      { name: "q", status: "zero tests" },
      { name: "r", status: "done" },
      { name: "s", status: "half-baked" },
      { name: "t", status: true },
      { name: "u", status: "✅" },
    ]);
    expect(read.columns).toEqual([]);
    expect(read.criteria.map((criterion) => [criterion.name, criterion.own.status, checkLabel(criterion.own)])).toEqual([
      ["a", "passed", "Passed"],
      ["b", "passed", "Passed"],
      ["c", "passed", "Passed"],
      ["d", "passed", "Verified by reviewer"],
      ["e", "failed", "Failed"],
      ["f", "failed", "Failed (not met)"],
      ["g", "blocked", "Blocked"],
      ["h", "untested", "Not tested (not exercised)"],
      ["i", "untested", "Not tested (pending)"],
      ["j", "untested", "Not tested (unknown)"],
      ["k", "untested", "Not applicable"],
      ["l", "claimed", "Claimed, not independently checked"],
      ["m", "claimed", "Claimed by owner, not independently checked"],
      ["n", "claimed", "Claimed by builder (unverified), not independently checked"],
      ["o", "skipped", "Skipped"],
      ["p", "skipped", "Skipped (no match)"],
      ["q", "skipped", "Skipped (zero tests)"],
      ["r", "claimed", "Claimed (done), not independently checked"],
      ["s", "untested", "Not tested: “half-baked” is not a known status"],
      ["t", "passed", "Passed"],
      ["u", "passed", "Passed"],
    ]);
  });

  it("says the verdict in plain words, conclusion first", () => {
    const criteria: Value = [
      { name: "Signs in", status: "passed" },
      { name: "Signs out", status: "passed" },
      { name: "Resets password", status: "passed" },
      { name: "Upgrade keeps data", status: "failed" },
      { name: "Offline banner", status: "failed" },
      { name: "Installs on the phone", status: "blocked", note: "No phone connected" },
      { name: "Push opens the thread", status: "claimed" },
      { name: "Deep links", status: "owner-reported" },
    ];
    expect(line(criteria)).toBe("Not done: 3 of 8 criteria proven · 2 failing · 1 blocked · 2 only claimed");
    expect(acceptanceVerdict(report(criteria)).tone).toBe("bad");
  });

  it("separates required from optional and calls only claims 'not proven'", () => {
    expect(
      line([
        { name: "Builds", status: "passed" },
        { name: "Tests", status: "passed" },
        { name: "Docs", status: "untested", required: false },
      ]),
    ).toBe("Done: all 2 required criteria proven");
    const verdict = acceptanceVerdict(report([{ name: "A", status: "passed" }, { name: "B", status: "done" }, { name: "C", status: "skipped", optional: true }]));
    expect(verdictLine(verdict)).toBe("Not proven: 1 of 2 required criteria proven · 1 only claimed");
    expect([verdict.tone, verdict.optional]).toEqual(["warn", { total: 1, proven: 0 }]);
  });

  it("leaves n/a out of the count and says so nowhere as a gap", () => {
    const read = report([{ name: "A", status: "passed" }, { name: "B", status: "N/A" }]);
    expect(read.criteria.filter(isGap).map((criterion) => criterion.name)).toEqual([]);
    expect(acceptanceVerdict(read)).toMatchObject({ headline: "Done", notApplicable: 1, proven: "all 1 criterion proven" });
  });

  it("collects what needs the user, grouped by the thing to do", () => {
    const verdict = acceptanceVerdict(
      report([
        { name: "Installs", status: "needs you", note: "Unlock the iPhone" },
        { name: "Launches", needs: "Unlock the iPhone" },
        { name: "Pricing tier", status: "blocked", needs: "Pick the launch tier" },
        { name: "Builds", status: "passed", needs: "ignored once passed" },
      ]),
    );
    expect(verdict.needsYou).toEqual([
      { what: "Unlock the iPhone", where: [{ criterion: "Installs", columns: [] }, { criterion: "Launches", columns: [] }] },
      { what: "Pick the launch tier", where: [{ criterion: "Pricing tier", columns: [] }] },
    ]);
    expect(needsPlaces(verdict.needsYou[0]!)).toBe("Installs and Launches");
    expect(verdictLine(verdict)).toBe("Not done: 1 of 4 criteria proven · 3 blocked");
  });

  it("reads bare strings as criteria with no result recorded, and streams half-written items", () => {
    const read = report(["Builds", { name: "Tests", status: "pass" }, { status: "fa" }]);
    expect(read.criteria.map((criterion) => checkLabel(criterion.own))).toEqual(["No result recorded", "Passed"]);
    expect(read.unnamed).toBe(1);
    expect(line([])).toBe("No criteria yet");
  });

  it("keeps unicode names and the criterion's own fields", () => {
    const [criterion] = report([
      { criterion: "Résumé ✓ 日本語", detail: "d", status: "passed", by: "QA", method: "manual", run: "a1b2c3d", at: "2026-10-09T14:32:00Z", note: "ok" },
    ]).criteria;
    expect(criterion).toMatchObject({ name: "Résumé ✓ 日本語", detail: "d", own: { by: "QA", method: "manual", run: "a1b2c3d", at: "2026-10-09T14:32:00Z", note: "ok" } });
    expect(checkSummary(criterion!.name, null, criterion!.own)).toBe("Résumé ✓ 日本語: Verified by QA — ok");
  });

  it("refuses what is no acceptance data", () => {
    expect(readAcceptance(42)).toMatchObject({ ok: false });
    expect(readAcceptance("done")).toMatchObject({ ok: false });
    expect(readAcceptance({ foo: { bar: 1 } })).toMatchObject({ ok: false });
    expect(readAcceptance({ name: "x", status: "pass" })).toMatchObject({ ok: false });
  });
});

describe("readAcceptance: a matrix of conditions", () => {
  const matrix: Value = [
    { name: "Upgrade keeps data", cells: { iPhone: "pass", Mac: { status: "fail", note: "Store wiped", by: "validator" } } },
    { name: "Cold start < 2 s", cells: { iPhone: { status: "blocked", needs: "Unlock the iPhone" }, Mac: "verified", Simulator: "n/a" } },
    { name: "Export works", status: "passed", cells: { iPhone: "pass", Mac: "claimed", Simulator: "pass" } },
    { name: "Crash-free", cells: { Mac: "pass" } },
  ];

  it("takes columns from the cells in first-seen order and reads each row as its worst condition", () => {
    const read = report(matrix);
    expect(read.columns).toEqual(["iPhone", "Mac", "Simulator"]);
    expect(read.criteria.map((criterion) => criterion.own.status)).toEqual(["failed", "blocked", "claimed", "untested"]);
    // A missing cell is no result, not a pass.
    expect(checkLabel(read.criteria[3]!.cells![0]!)).toBe("No result recorded");
    // A status written on the row that its cells contradict.
    expect(read.criteria[2]!.stated).toBe("passed");
    expect(read.criteria[0]!.stated).toBeNull();
  });

  it("counts cells apart from criteria, n/a cells aside", () => {
    const verdict = acceptanceVerdict(report(matrix));
    expect(verdictLine(verdict)).toBe("Not done: 0 of 4 criteria proven · 1 failing · 1 blocked · 1 not tested · 1 only claimed");
    expect(cellsLine(verdict)).toBe("11 cells (1 not applicable): 5 proven · 1 only claimed · 3 not tested · 1 blocked · 1 failing");
    expect(verdict.needsYou).toEqual([{ what: "Unlock the iPhone", where: [{ criterion: "Cold start < 2 s", columns: ["iPhone"] }] }]);
    expect(needsPlaces(verdict.needsYou[0]!)).toBe("Cold start < 2 s (iPhone)");
  });

  it("orders and limits columns by the columns param, and says how many it left out", () => {
    const read = report(matrix, ["Mac", "iPhone"]);
    expect(read.columns).toEqual(["Mac", "iPhone"]);
    expect(read.hiddenColumns).toBe(1);
    expect(read.criteria[0]!.cells!.map((cell) => cell.status)).toEqual(["failed", "passed"]);
    expect(read.criteria[2]!.own.status).toBe("claimed");
  });

  it("reads list cells by a column key or by position", () => {
    const named = report([{ name: "Fits", cells: [{ viewport: "Phone", status: "pass" }, { viewport: "Desktop", status: "fail" }] }]);
    expect(named.columns).toEqual(["Phone", "Desktop"]);
    const positional = report([{ name: "Fast", cells: ["pass", "fail", "pass"] }], ["Run 1", "Run 2", "Run 3"]);
    expect(positional.criteria[0]!.cells!.map((cell) => cell.status)).toEqual(["passed", "failed", "passed"]);
    expect(report([{ name: "Fast", cells: ["pass", "fail"] }]).columns).toEqual(["#1", "#2"]);
  });

  it("reads flat rows (a CSV through Load) with status-valued keys as columns", () => {
    const read = report([
      { criterion: "Hero fits", Desktop: "pass", Tablet: "pass", Phone: "fail", note: "CTA wraps" },
      { criterion: "Form submits", Desktop: "pass", Tablet: "", Phone: "pending" },
    ]);
    expect(read.columns).toEqual(["Desktop", "Tablet", "Phone"]);
    expect(read.criteria.map((criterion) => criterion.own.status)).toEqual(["failed", "untested"]);
    expect(read.criteria[0]!.own.note).toBe("CTA wraps");
    expect(read.criteria[1]!.cells![1]!.recorded).toBe(false);
  });

  it("reads all-n/a rows as not applicable", () => {
    const read = report([{ name: "Mac only", cells: { iPhone: "n/a", Mac: "n/a" } }, { name: "A", cells: { iPhone: "pass", Mac: "pass" } }]);
    expect(read.criteria[0]!.own.notApplicable).toBe(true);
    expect(verdictLine(acceptanceVerdict(read))).toBe("Done: all 1 criterion proven");
  });

  it("keeps a 1,000 × 10 matrix fast", () => {
    const columns = Array.from({ length: 10 }, (_, index) => `C${index}`);
    const rows: Value = Array.from({ length: 1000 }, (_, index) => ({ name: `Row ${index}`, cells: Object.fromEntries(columns.map((column, position) => [column, (index + position) % 7 === 0 ? "fail" : "pass"])) }));
    const started = performance.now();
    const verdict = acceptanceVerdict(report(rows));
    expect(performance.now() - started).toBeLessThan(500);
    expect(verdict.cells?.total).toBe(10_000);
  });
});

describe("readAcceptance: reports through Load", () => {
  it("reads {criteria} and {rows} wrappers with their title and columns", () => {
    expect(report({ title: "Launch", criteria: [{ name: "A", status: "pass" }] }).title).toBe("Launch");
    const rows = report({ rows: [{ name: "A", cells: { x: "pass", y: "fail" } }], columns: ["y"] });
    expect([rows.columns, rows.hiddenColumns]).toEqual([["y"], 1]);
  });

  it("reads a gate's {matrix: {row: {column: status}}} and a {name: status} map", () => {
    const gate = report({ subject: "Snake", matrix: { Desktop: { Chrome: "pass", Safari: "fail" }, Touch: { Chrome: "blocked" } } });
    expect([gate.title, gate.columns, gate.criteria.map((criterion) => criterion.own.status)]).toEqual(["Snake", ["Chrome", "Safari"], ["failed", "blocked"]]);
    const map = report({ "Builds": "pass", "Tests": { status: "fail", note: "2 failing" } });
    expect(map.criteria.map((criterion) => [criterion.name, criterion.own.status])).toEqual([
      ["Builds", "passed"],
      ["Tests", "failed"],
    ]);
  });

  it("reads an owner's result: its contract is claimed by the owner, blockers block, complete:true is contradicted", () => {
    const owner = report({
      owner: "builder",
      complete: true,
      contract: ["Arena-only view", { criterion: "Reduced motion", status: "passed", evidence: "src/shell.ts:40" }],
      blockers: ["Rook billing is blocked"],
      limitations: ["Chrome mobile emulation only"],
    });
    expect(owner.criteria.map((criterion) => [criterion.name, checkLabel(criterion.own)])).toEqual([
      ["Arena-only view", "Claimed by builder, not independently checked"],
      ["Reduced motion", "Passed"],
      ["Rook billing is blocked", "Blocked"],
    ]);
    expect(owner.limitations).toEqual(["Chrome mobile emulation only"]);
    expect(ownerContradiction(owner, acceptanceVerdict(owner))).toBe("Owner reports complete, but 2 required criteria are not proven");
  });

  it("reads the arcade gate fixture: published but not done", () => {
    const gate = report(fixture("acceptance/coil-gate.json"));
    const verdict = acceptanceVerdict(gate);
    expect(gate.title).toBe("Coil redesign gate");
    expect(verdictLine(verdict)).toBe("Not done: 2 of 9 required criteria proven · 2 failing · 1 blocked · 3 not tested · 1 only claimed");
    expect(verdict.needsYou.map((item) => [item.what, needsPlaces(item)])).toEqual([["Restore Rook billing", "Plays a live Rook match (Source server, Published site)"]]);
    expect(ownerContradiction(gate, verdict)).toBe("Owner reports complete, but 7 required criteria are not proven");
    const tests = gate.criteria.find((criterion) => criterion.name === "Local tests and build")!;
    expect(checkLabel(tests.cells![0]!)).toBe("Claimed by owner, not independently checked");
    expect(tests.cells![1]!.notApplicable).toBe(true);
  });

  it("reads the 24-cell baseline fixture: every cell blocked, with its reason", () => {
    const baseline = report(fixture("acceptance/orbit-baseline.json"));
    const verdict = acceptanceVerdict(baseline);
    expect(baseline.columns).toHaveLength(6);
    expect(cellsLine(verdict)).toBe("24 cells: 24 blocked");
    expect(verdictLine(verdict)).toBe("Not done: 0 of 4 criteria proven · 4 blocked");
    expect(baseline.criteria.flatMap((criterion) => criterion.cells!).every((cell) => cell.note !== null)).toBe(true);
    expect(verdict.needsYou.map((item) => item.what)).toEqual(["Connect the iPhone to the operator host and keep it unlocked"]);
    expect(needsPlaces(verdict.needsYou[0]!, 2)).toBe("iPhone · Whisper and iPhone · LiteRT in Tier 1 latency baseline, Tier 2 latency baseline and Tier 3 latency baseline");
    expect(needsPlaces(verdict.needsYou[0]!, 1)).toBe("iPhone · Whisper and iPhone · LiteRT in Tier 1 latency baseline and 2 more");
  });
});

describe("readEvidence", () => {
  it("tells files, lines, links, images and text apart", () => {
    expect(
      readEvidence([
        "src/app.ts:42",
        "src/app.test.ts:10-14",
        "core/x.ts#L5-L9",
        "C:\\repo\\a.ts:3:7",
        "$BB_THREAD_STORAGE/finish-verification.json",
        "/tmp/shot.png",
        "https://example.com/run/12",
        "https://example.com/a.png?x=1",
        "http://localhost:3000/b.png",
        "506/506 tests passed",
        "506/506",
        "v1.2.3",
        { path: "a.ts", line: 3, endLine: 2, label: "entry" },
        { url: "https://ci.example.com/42", label: "CI" },
        { image: "shots/phone.png" },
        { text: "PASS 12 tests", label: "vitest" },
        null,
      ]),
    ).toEqual([
      { kind: "file", path: "src/app.ts", line: 42, endLine: null, label: null },
      { kind: "file", path: "src/app.test.ts", line: 10, endLine: 14, label: null },
      { kind: "file", path: "core/x.ts", line: 5, endLine: 9, label: null },
      { kind: "file", path: "C:\\repo\\a.ts", line: 3, endLine: null, label: null },
      { kind: "file", path: "$BB_THREAD_STORAGE/finish-verification.json", line: null, endLine: null, label: null },
      { kind: "image", src: "/tmp/shot.png", label: null },
      { kind: "url", url: "https://example.com/run/12", label: null },
      { kind: "image", src: "https://example.com/a.png?x=1", label: null },
      { kind: "url", url: "http://localhost:3000/b.png", label: null },
      { kind: "text", text: "506/506 tests passed", label: null },
      { kind: "text", text: "506/506", label: null },
      { kind: "text", text: "v1.2.3", label: null },
      { kind: "file", path: "a.ts", line: 3, endLine: null, label: "entry" },
      { kind: "url", url: "https://ci.example.com/42", label: "CI" },
      { kind: "image", src: "shots/phone.png", label: null },
      { kind: "text", text: "PASS 12 tests", label: "vitest" },
    ]);
  });

  it("gathers evidence from every key a check may use", () => {
    const [criterion] = report([{ name: "A", status: "pass", evidence: "a.ts:1", screenshot: "s.png", artifacts: ["r.json"] }]).criteria;
    expect(criterion!.own.evidence.map((item) => item.kind)).toEqual(["file", "file", "image"]);
  });
});
