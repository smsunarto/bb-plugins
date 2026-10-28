import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDataFile } from "./data";
import { MAX_LOG_LINES, findLinks, firstError, foldRepeats, levelOf, lineRuns, occurrences, readLogs, stampLength, textLevel, type LogOutput } from "./logs";
import type { Value } from "./types";

/** Real logs in gallery/data/logs (see the gallery examples), read as Load reads them. */
function fixture(name: string): Value {
  const loaded = parseDataFile(name, readFileSync(new URL(`../gallery/data/logs/${name}`, import.meta.url), "utf8"));
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.value;
}

function read(value: Value): LogOutput {
  const result = readLogs(value);
  if (!result.ok) throw new Error(result.error);
  return result.output;
}

describe("readLogs: text", () => {
  it("reads a coloured vitest run: ANSI runs, failures as errors, file:line links", () => {
    const output = read(fixture("vitest-run.log"));
    expect(output.format).toBe("text");
    expect(output.lines).toHaveLength(87);
    expect(output.lines[0].text).toBe(" RUN  v4.1.11 /home/dev/bb-plugin-genui");
    expect(output.lines[0].segments?.map((s) => s.color)).toEqual(["dim", null, "cyan", "dim"]);
    expect(output.counts).toMatchObject({ error: 3, warn: 0 });
    const errors = output.lines.filter((line) => line.level === "error").map((line) => line.text.trim());
    expect(errors).toEqual([
      "× has an example for every component 15ms",
      "FAIL  gallery.test.ts > gallery > has an example for every component",
      "AssertionError: expected [ 'Logs', 'StackTrace', …(14) ] to deeply equal []",
    ]);
    expect(firstError(output.lines)).toBe(15);
    const linked = output.lines.find((line) => line.links.length > 0)!;
    expect(linked.links).toEqual([{ start: 3, end: 24, path: "gallery.test.ts", line: 26, column: 21 }]);
  });

  it("reads a Python logging file: timestamps quiet, tracebacks continuing their entry", () => {
    const output = read(fixture("media-sync.log"));
    expect(output.counts).toEqual({ fatal: 1, error: 2, warn: 10, info: 4, debug: 91, trace: 0 });
    const first = output.lines[0];
    expect([first.level, first.stamp, first.quiet]).toEqual(["info", 23, [[0, 23]]]);
    const traceback = output.lines.findIndex((line) => line.text === "Traceback (most recent call last):");
    expect(output.lines[traceback]).toMatchObject({ level: "error", continued: true });
    // A blank line inside the traceback keeps the entry's level.
    const blank = output.lines.findIndex((line, index) => index > traceback && line.text === "");
    expect(output.lines[blank + 1]).toMatchObject({ text: "The above exception was the direct cause of the following exception:", level: "error" });
    const frame = output.lines.find((line) => line.text.includes('File "data/traces/py/settings.py", line 15'))!;
    expect(frame.links).toMatchObject([{ path: "data/traces/py/settings.py", line: 15, column: null }]);
    // Nine identical warnings, timestamps aside, fold into one row.
    const rows = foldRepeats(output.lines, output.lines.map((_, index) => index));
    expect(rows.find((row) => row.count > 1)).toEqual({ index: expect.any(Number), count: 9 });
    expect(rows).toHaveLength(output.lines.length - 8);
  });

  it("reads a list of lines, a leveled log's untagged lines continuing their entry", () => {
    const output = read(["[info] listening", "[error] POST /cart 500", "    at lineTotal (src/pricing.ts:10:46)", "[info] GET /health 200"]);
    expect(output.lines.map((line) => [line.level, line.continued])).toEqual([
      ["info", false],
      ["error", false],
      ["error", true],
      ["info", false],
    ]);
    expect(output.counts).toMatchObject({ info: 2, error: 1 });
  });

  it("shows what a terminal shows: progress redraws, control characters, Windows line ends, leading blanks", () => {
    const output = read("\r\n\r\nDownloading 10%\rDownloading 60%\rDownloading 100%\r\n\x04\b\bdone ✓ 東京\r\n\r\n");
    expect(output.lines.map((line) => line.text)).toEqual(["Downloading 100%", "done ✓ 東京"]);
  });

  it("keeps the last lines of huge output and reads empty output", () => {
    const output = read(Array.from({ length: MAX_LOG_LINES + 5 }, (_, index) => `line ${index + 1}`).join("\n"));
    expect(output.dropped).toBe(5);
    expect(output.lines[0].text).toBe("line 6");
    expect(read("").lines).toEqual([]);
    expect(read([]).lines).toEqual([]);
    expect(readLogs(12)).toMatchObject({ ok: false });
  });
});

describe("readLogs: JSON records", () => {
  it("reads pino JSONL: numeric levels, UTC times, shared fields said once, err.stack under its record", () => {
    const output = read(fixture("thumbnailer.jsonl"));
    expect(output.format).toBe("records");
    expect(output.utc).toBe(true);
    expect(output.context).toEqual([
      ["pid", "23437"],
      ["hostname", "build-07"],
      ["service", "thumbnailer"],
    ]);
    expect(output.counts).toEqual({ fatal: 1, error: 1, warn: 6, info: 4, debug: 5, trace: 0 });
    expect(output.lines[0]).toMatchObject({ text: "00:15:31.832 worker started  queue=thumbnails concurrency=4", level: "info", stamp: 12, quiet: [[0, 12], [27, 59]] });
    const failed = output.lines.findIndex((line) => line.text.includes("job failed after 3 attempts"));
    expect(output.lines.slice(failed + 1, failed + 4).map((line) => [line.text.trim(), line.level, line.continued])).toEqual([
      ["Error: unsupported image format: uploads/2026/10/IMG_2291.heic", "error", true],
      ["at resize (file:///srv/thumbnailer/worker.mjs:7:41)", "error", true],
      ["at file:///srv/thumbnailer/worker.mjs:25:23", "error", true],
    ]);
    expect(output.lines[failed + 2].links).toMatchObject([{ path: "/srv/thumbnailer/worker.mjs", line: 7, column: 41 }]);
  });

  it("reads winston, bunyan, structlog, zap and Python records, and JSONL saved as text", () => {
    const output = read([
      { level: "warn", message: "disk 91% full", timestamp: "2026-10-10T08:00:00.000Z", service: "api" },
      { level: 50, msg: "upstream timeout", time: "2026-10-10T08:00:01.250Z", name: "api", v: 0 },
      { event: "user signed in", level: "info", timestamp: "2026-10-10T08:00:02Z", user_id: 42 },
      { level: "debug", ts: 1791619203.5, msg: "cache miss", key: "u:42" },
      { levelno: 40, levelname: "ERROR", message: "boom" },
      { severity: "CRITICAL", message: "out of memory" },
    ]);
    expect(output.lines.map((line) => [line.level, line.text])).toEqual([
      ["warn", "08:00:00.000 disk 91% full  service=api"],
      ["error", "08:00:01.250 upstream timeout  name=api v=0"],
      ["info", "08:00:02.000 user signed in  user_id=42"],
      ["debug", "08:00:03.500 cache miss  key=u:42"],
      ["error", "boom"],
      ["fatal", "out of memory"],
    ]);
    const text = read('{"level":30,"time":1791591331832,"msg":"a"}\n{"level":40,"time":1791591331833,"msg":"b"}\n');
    expect(text.format).toBe("records");
    expect(text.lines.map((line) => line.level)).toEqual(["info", "warn"]);
  });

  it("dates record times when the log spans days", () => {
    const output = read([
      { level: "info", msg: "a", time: "2026-10-09T23:59:59Z" },
      { level: "info", msg: "b", time: "2026-10-10T00:00:01Z" },
    ]);
    expect(output.lines.map((line) => line.text)).toEqual(["2026-10-09 23:59:59.000 a", "2026-10-10 00:00:01.000 b"]);
  });
});

describe("levels, timestamps, links", () => {
  it("detects a level in each common spelling", () => {
    const cases: [string, string | null][] = [
      ["2026-10-10T08:00:00Z ERROR api: boom", null],
      ["ERROR api: boom", "error"],
      ["[warn] slow", "warn"],
      ["[E] native crash", "error"],
      ["E/ActivityManager( 1234): ANR in com.acme", "error"],
      ["W/System: ignoring", "warn"],
      ["1234  1234 I Tag: hello", "info"],
      ["E1010 02:16:59.123456   12 main.go:12] watch failed", "error"],
      ["level=error msg=\"db down\"", "error"],
      ["lvl=dbug msg=x", null],
      ["time=1 level=50 msg=x", "error"],
      ["<3>kernel: oops", "error"],
      ["<6>kernel: ready", "info"],
      ["npm ERR! code ELIFECYCLE", "error"],
      ["npm warn deprecated inflight@1.0.6", "warn"],
      ["src/a.ts(3,7): error TS2322: Type 'string' is not assignable", "error"],
      ["src/main.rs:4:9: warning: unused variable: `x`", "warn"],
      ["warning[unused_imports]: unused import", "warn"],
      ["error[E0308]: mismatched types", "error"],
      ["TypeError: x is not a function", "error"],
      ["(node:42) DeprecationWarning: Buffer() is deprecated", "warn"],
      ["   × has an example", "error"],
      ["FAIL src/a.test.ts", "error"],
      ["panic: boom", "error"],
      ["Traceback (most recent call last):", "error"],
      ['{"level":"warn","msg":"x"}', "warn"],
      ["CRITICAL sync finished", "fatal"],
      ["Error: ENOENT", "error"],
      ["all good, no errors found", null],
      ["Compiled successfully in 1.2s", null],
    ];
    // The first case is read whole here; the parser reads after the timestamp (see the Python log test).
    expect(cases.map(([text]) => [text, textLevel(text)])).toEqual(cases.map(([text, level]) => [text, text.startsWith("2026") ? "error" : level]));
    expect([levelOf(10), levelOf(30), levelOf(60), levelOf(4), levelOf(40, "python"), levelOf("Warning"), levelOf("nope")]).toEqual([
      "trace",
      "info",
      "fatal",
      "warn",
      "error",
      "warn",
      null,
    ]);
  });

  it("measures leading timestamps", () => {
    expect(
      [
        "2026-10-10 02:16:59,142 INFO x",
        "2026-10-10T02:16:59.123456789Z x",
        "[2026-10-10 02:16:59] x",
        "Oct 10 02:16:59 host x",
        "10-10 02:16:59.123  1 2 I x",
        "02:16:59.123 x",
        "2026/10/10 02:16:59 x",
        "1234 not a time",
      ].map(stampLength),
    ).toEqual([23, 30, 21, 15, 18, 12, 19, 0]);
  });

  it("finds file:line locations, not URLs", () => {
    const links = (text: string) => findLinks(text).map((link) => `${link.path}:${link.line}:${link.column ?? "-"} @${link.start}-${link.end}`);
    expect(links(" ❯ gallery.test.ts:26:21")).toEqual(["gallery.test.ts:26:21 @3-24"]);
    expect(links("at x (file:///repo/src/a.ts:3:9)")).toEqual(["/repo/src/a.ts:3:9 @6-31"]);
    expect(links('  File "app/models.py", line 88, in save')).toEqual(["app/models.py:88:- @2-31"]);
    expect(links("src/a.ts(3,7): error TS2322")).toEqual(["src/a.ts:3:7 @0-13"]);
    expect(links("see https://example.com/a.js:1:2 and http://localhost:5173/src/b.ts:3")).toEqual([]);
    expect(links("version 1.2.3 at 10:42")).toEqual([]);
  });
});

describe("viewer pieces", () => {
  it("cuts a line into styled runs at colours, quiet ranges, links and matches", () => {
    const [line] = read("\u001b[31m02:16:59 failed at src/a.ts:3\u001b[39m done").lines;
    expect(lineRuns(line, "FAIL").map((run) => [run.text, run.color, run.quiet, run.link?.path ?? null, run.match])).toEqual([
      ["02:16:59", "red", true, null, false],
      [" ", "red", false, null, false],
      ["fail", "red", false, null, true],
      ["ed at ", "red", false, null, false],
      ["src/a.ts:3", "red", false, "src/a.ts", false],
      [" done", null, false, null, false],
    ]);
    expect(occurrences("aAa", "a")).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(occurrences("abc", "")).toEqual([]);
  });

  it("folds only consecutive identical lines, not blank ones or lines the filter split", () => {
    const output = read(["x", "x", "", "", "x", "y"]);
    expect(foldRepeats(output.lines, [0, 1, 2, 3, 4, 5])).toEqual([
      { index: 0, count: 2 },
      { index: 2, count: 1 },
      { index: 3, count: 1 },
      { index: 4, count: 1 },
      { index: 5, count: 1 },
    ]);
    expect(foldRepeats(output.lines, [0, 4])).toEqual([
      { index: 0, count: 1 },
      { index: 4, count: 1 },
    ]);
  });
});
