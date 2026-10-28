import { describe, expect, it } from "vitest";
import {
  ansiLines,
  ansiSegments,
  commonDirectory,
  countsText,
  displayPath,
  firstAppFrame,
  formatDuration,
  libraryFrame,
  groupTests,
  readTestRun,
  stackFrame,
  stripAnsi,
  testStatus,
  workspacePath,
  type TestRun,
} from "./test-results";
import type { Value } from "./types";

function run(value: Value): TestRun {
  const result = readTestRun(value);
  if (!result.ok) throw new Error(result.error);
  return result.run;
}

describe("readTestRun: plain lists", () => {
  it("reads the catalog shape, splitting `file:line` and counting by status", () => {
    const { tests, counts, ms, ignored } = run([
      { name: "adds", status: "passed", ms: 3 },
      { name: "divides", status: "fail", message: "expected 2", file: "src/math.test.ts:14:7" },
      { name: "rounds", status: "todo" },
      { title: "parses", state: "OK", duration: 1.5, location: { line: 9, column: 2 }, path: "a.test.ts" },
      { name: "no status" },
      "a string",
    ]);
    expect(tests.map((test) => [test.name, test.status, test.detail, test.file, test.line])).toEqual([
      ["adds", "passed", null, null, null],
      ["divides", "failed", null, "src/math.test.ts", 14],
      ["rounds", "skipped", "todo", null, null],
      ["parses", "passed", null, "a.test.ts", 9],
    ]);
    expect(counts).toEqual({ passed: 2, failed: 1, skipped: 1 });
    expect(ms).toBe(4.5);
    expect(ignored).toBe(2);
  });

  it("reads suites of tests, as a very large JUnit report arrives", () => {
    const { tests } = run([{ suite: "tests.test_api", tests: [{ name: "a", status: "passed" }] }, { name: "b", status: "error" }]);
    expect(tests.map((test) => [test.name, test.suite, test.status, test.detail])).toEqual([
      ["a", "tests.test_api", "passed", null],
      ["b", null, "failed", "error"],
    ]);
  });

  it("says what it needs when nothing in the value is a test", () => {
    expect(readTestRun([{ label: "x" }])).toEqual({ ok: false, error: "Tests items need a name and a status (passed, failed or skipped)" });
    expect(readTestRun("all good")).toEqual({
      ok: false,
      error: "Tests needs a list of {name, status}, a vitest/jest JSON report or a JUnit XML report",
    });
    expect(run([]).tests).toEqual([]);
  });

  it("locates a failure with no line from the first app frame of its trace", () => {
    const [pytest, vitest, elsewhere] = run([
      { name: "py", status: "failed", message: "E  assert 1 == 2\n\ntests/test_api.py:22: AssertionError" },
      {
        name: "js",
        status: "failed",
        file: "/repo/src/a.test.ts",
        message: "Error: no\n    at f (/repo/node_modules/x/index.js:1:1)\n    at /repo/src/a.test.ts:31:9",
      },
      { name: "other", status: "failed", file: "src/b.test.ts", message: "at helper (src/lib.ts:4:2)" },
    ]).tests;
    expect([pytest.file, pytest.line]).toEqual(["tests/test_api.py", 22]);
    expect([vitest.file, vitest.line]).toEqual(["/repo/src/a.test.ts", 31]);
    expect([elsewhere.file, elsewhere.line]).toEqual(["src/b.test.ts", null]);
  });
});

describe("readTestRun: vitest and jest JSON", () => {
  const report: Value = {
    numTotalTests: 4,
    startTime: 1000,
    success: false,
    testResults: [
      {
        name: "/repo/core/data.test.ts",
        status: "failed",
        startTime: 1010,
        endTime: 1300,
        message: "",
        assertionResults: [
          {
            ancestorTitles: ["parseDataFile", "csv"],
            fullName: "parseDataFile csv reads quotes",
            title: "reads quotes",
            status: "passed",
            duration: 2.5,
            failureMessages: [],
          },
          {
            ancestorTitles: [],
            fullName: "rejects bad rows",
            title: "rejects bad rows",
            status: "failed",
            duration: 4,
            location: { line: 40, column: 3 },
            failureMessages: ["\u001b[31mAssertionError: expected 2 to be 3\u001b[39m\n    at /repo/core/data.test.ts:41:18"],
          },
          { ancestorTitles: ["later"], title: "pending one", status: "pending", failureMessages: [] },
        ],
      },
      { name: "/repo/core/broken.test.ts", status: "failed", message: "SyntaxError: Unexpected token", assertionResults: [] },
    ],
  };

  it("reads files, names with their describe blocks, and the wall-clock duration", () => {
    const { tests, counts, ms } = run(report);
    expect(tests.map((test) => [test.name, test.status, test.suite, test.line, test.ms])).toEqual([
      ["parseDataFile › csv › reads quotes", "passed", "/repo/core/data.test.ts", null, 2.5],
      ["rejects bad rows", "failed", "/repo/core/data.test.ts", 40, 4],
      ["later › pending one", "skipped", "/repo/core/data.test.ts", null, null],
      ["(the file failed to run)", "failed", "/repo/core/broken.test.ts", null, null],
    ]);
    expect(tests[1].message).toContain("AssertionError: expected 2 to be 3");
    expect(tests[3].message).toBe("SyntaxError: Unexpected token");
    expect(counts).toEqual({ passed: 1, failed: 2, skipped: 1 });
    expect(ms).toBe(300);
  });
});

describe("testStatus", () => {
  it("maps the reporters' words onto three statuses, keeping the telling ones", () => {
    const read = (word: Value) => {
      const status = testStatus(word);
      return status === null ? null : `${status.status}${status.detail === null ? "" : `/${status.detail}`}`;
    };
    expect(["PASS", "ok", "success", "fail", "Failure", "error", "timed_out", "skip", "pending", "todo", "disabled", "xfail", true, false, "running", 3].map(read)).toEqual([
      "passed",
      "passed",
      "passed",
      "failed",
      "failed",
      "failed/error",
      "failed/timed out",
      "skipped",
      "skipped/pending",
      "skipped/todo",
      "skipped/disabled",
      "skipped/xfail",
      "passed",
      "failed",
      null,
      null,
    ]);
  });
});

describe("groupTests and text", () => {
  it("groups by suite, else file, in first-seen order with counts and time", () => {
    const { tests } = run([
      { name: "a", status: "passed", suite: "S", ms: 1 },
      { name: "b", status: "skipped", file: "f.ts" },
      { name: "c", status: "failed", suite: "S", ms: 2 },
      { name: "d", status: "passed" },
    ]);
    expect(groupTests(tests).map((group) => [group.label, group.tests.length, group.counts, group.ms])).toEqual([
      ["S", 2, { passed: 1, failed: 1, skipped: 0 }, 3],
      ["f.ts", 1, { passed: 0, failed: 0, skipped: 1 }, null],
      ["Tests", 1, { passed: 1, failed: 0, skipped: 0 }, null],
    ]);
  });

  it("writes counts failures first and durations at a readable precision", () => {
    expect(countsText({ passed: 45, failed: 3, skipped: 0 })).toBe("3 failed, 45 passed");
    expect(countsText({ passed: 0, failed: 0, skipped: 0 })).toBe("no tests");
    expect([0, 0.42, 12.4, 1240, 14_230, 125_000, 3_725_000].map(formatDuration)).toEqual([
      "0 ms",
      "0.4 ms",
      "12 ms",
      "1.24 s",
      "14.2 s",
      "2m 05s",
      "1h 02m",
    ]);
  });
});

describe("ANSI", () => {
  it("splits colour runs and drops every other escape", () => {
    expect(ansiSegments("\u001b[2mExpected\u001b[22m: \u001b[32m3\u001b[39m \u001b[1;91mgot\u001b[0m\u001b[2K\u001b]8;;http://x\u0007!")).toEqual([
      { text: "Expected", color: "dim", bold: false, inverse: false },
      { text: ": ", color: null, bold: false, inverse: false },
      { text: "3", color: "green", bold: false, inverse: false },
      { text: " ", color: null, bold: false, inverse: false },
      { text: "got", color: "red", bold: true, inverse: false },
      { text: "!", color: null, bold: false, inverse: false },
    ]);
    expect(ansiSegments("\u001b[38;5;9mx\u001b[38;2;1;2;3my\u001b[7mz")).toEqual([
      { text: "x", color: "red", bold: false, inverse: false },
      { text: "y", color: null, bold: false, inverse: false },
      { text: "z", color: null, bold: false, inverse: true },
    ]);
    expect(stripAnsi("\u001b[31m- a\u001b[39m\n\u001b[32m+ b\u001b[39m\u001b[1A")).toBe("- a\n+ b");
  });

  it("carries a colour across line breaks", () => {
    expect(ansiLines("\u001b[31mone\r\ntwo\u001b[39m\n\nthree").map((line) => line.map((s) => `${s.color}:${s.text}`))).toEqual([
      ["red:one"],
      ["red:two"],
      [],
      ["null:three"],
    ]);
  });
});

describe("stack frames", () => {
  it("reads the frames of each runtime's traces", () => {
    const frame = (line: string) => {
      const read = stackFrame(line);
      return read === null ? null : [read.path, read.line, read.column, read.app, read.linkable];
    };
    expect(frame("    at Object.<anonymous> (/repo/src/math.test.ts:14:7)")).toEqual(["/repo/src/math.test.ts", 14, 7, true, true]);
    expect(frame("    at file:///repo/node_modules/@vitest/runner/dist/index.js:155:14")).toEqual([
      "file:///repo/node_modules/@vitest/runner/dist/index.js",
      155,
      14,
      false,
      true,
    ]);
    expect(frame("    at node:internal/process/task_queues:95:5")).toBeNull();
    expect(frame(" ❯ core/data.test.ts:42:17")).toEqual(["core/data.test.ts", 42, 17, true, true]);
    expect(frame('  File "/repo/app/models.py", line 88, in save')).toEqual(["/repo/app/models.py", 88, null, true, true]);
    expect(frame('  File "/usr/lib/python3.12/json/decoder.py", line 3, in decode')?.[3]).toBe(false);
    expect(frame("tests/test_api.py:22: AssertionError")).toEqual(["tests/test_api.py", 22, null, true, true]);
    expect(frame("    users_test.go:31: got 2 users, want 3")).toEqual(["users_test.go", 31, null, true, true]);
    expect(frame("thread 'parses' panicked at src/lib.rs:12:5:")).toEqual(["src/lib.rs", 12, 5, true, true]);
    expect(frame("\tat com.acme.UserTest.creates(UserTest.java:27)")).toEqual(["UserTest.java", 27, null, true, false]);
    expect(frame("\tat org.junit.jupiter.api.Assertions.fail(Assertions.java:9)")?.[3]).toBe(false);
    expect(frame("   at Acme.Tests.UserTests.Creates() in /src/UserTests.cs:line 42")).toEqual(["/src/UserTests.cs", 42, null, true, true]);
    expect(frame("expected 3 to equal 4 at http://example.com:80/x")).toBeNull();
    expect(frame("AssertionError: expected 2 to be 3")).toBeNull();
  });

  it("tells dependency and runtime lines from the code under test", () => {
    expect(
      [
        "    at new Promise (<anonymous>)",
        "    at async Promise.all (index 0)",
        "    at file:///r/node_modules/@vitest/runner/dist/index.js:1:1",
        "    at /r/src/a.ts:9:3",
        "Expected: 3",
      ].map(libraryFrame),
    ).toEqual([true, true, true, false, false]);
  });

  it("finds the first frame of the code under test", () => {
    const lines = ["Error: boom", "    at fn (/r/node_modules/lib/a.js:1:1)", "    at run (/r/src/a.ts:9:3)", "    at /r/src/b.ts:1:1"];
    expect(firstAppFrame(lines)).toMatchObject({ index: 2, path: "/r/src/a.ts", line: 9 });
    expect(firstAppFrame(["no frames"])).toBeNull();
  });
});

describe("paths", () => {
  it("gives BB a workspace-relative path or none", () => {
    expect(workspacePath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(workspacePath("file:///repo/src/a%20b.ts", "/repo/")).toBe("src/a b.ts");
    expect(workspacePath("./src/a.ts", null)).toBe("src/a.ts");
    expect(workspacePath("/elsewhere/a.ts", "/repo")).toBeNull();
    expect(workspacePath("/repo/a.ts", null)).toBeNull();
    expect(workspacePath("../a.ts", "/repo")).toBeNull();
  });

  it("shortens absolute paths to the directory they share", () => {
    const common = commonDirectory(["/repo/core/a.test.ts", "/repo/ui/b.test.ts", "core/c.ts"]);
    expect(common).toBe("/repo/");
    expect(commonDirectory(["/repo/core/a.test.ts"])).toBe("/repo/core/");
    expect(displayPath("/repo/core/a.test.ts", null, common)).toBe("core/a.test.ts");
    expect(displayPath("/repo/core/a.test.ts", "/repo/core", common)).toBe("a.test.ts");
    expect(displayPath("tests/x.py", null, common)).toBe("tests/x.py");
  });
});
