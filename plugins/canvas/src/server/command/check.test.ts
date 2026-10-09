import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeBb, fileKeyOf, runCanvasCli } from "../fake-bb.ts";

const sample = readFileSync(
  new URL("../../../examples/flaky-test-triage.canvas.mdx", import.meta.url),
  "utf8",
);
// The agent runs on a Mac thread; the server's own host is a different machine.
const macThread = {
  thr: { hostId: "host_mac", storageRootPath: "/Users/me/.bb/thread-storage/thr" },
};
const inThread = { cwd: "/w", threadId: "thr" };

test("check prints the success line for a clean canvas at an absolute path", async () => {
  const bb = fakeBb({
    threads: macThread,
    files: { [fileKeyOf("host_mac", undefined, "/abs/a.canvas.mdx")]: { content: sample } },
  });
  const result = await runCanvasCli(bb, ["check", "/abs/a.canvas.mdx"], inThread);
  assert.deepEqual(result, {
    exitCode: 0,
    stdout:
      "ok — style default, 10 blocks, 7 components (Row, Stat, Callout, BarChart, Table, FileLink, DiffView), 0 state ids\n",
    stderr: "",
  });
  assert.deepEqual(bb.calls.filesRead, [{ hostId: "host_mac", path: "/abs/a.canvas.mdx" }]);
});

test("check resolves a relative path against the command cwd", async () => {
  const bb = fakeBb({
    threads: macThread,
    files: {
      [fileKeyOf("host_mac", undefined, "/work/notes/a.canvas.mdx")]: { content: "# hi\n" },
    },
  });
  const result = await runCanvasCli(bb, ["check", "notes/a.canvas.mdx"], {
    cwd: "/work",
    threadId: "thr",
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok — style default, 1 block, 0 components, 0 state ids\n");
});

test("check names the frontmatter style in the success line", async () => {
  const bb = fakeBb({
    threads: macThread,
    files: {
      [fileKeyOf("host_mac", undefined, "/w/a.canvas.mdx")]: {
        content: "---\nstyle: github\n---\n\n# hi\n",
      },
    },
  });
  const result = await runCanvasCli(bb, ["check", "a.canvas.mdx"], inThread);
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "ok — style github, 1 block, 0 components, 0 state ids\n",
    stderr: "",
  });
});

test("check --json stats carry the frontmatter style", async () => {
  const bb = fakeBb({
    threads: macThread,
    files: {
      [fileKeyOf("host_mac", undefined, "/w/a.canvas.mdx")]: {
        content: "---\nstyle: github\n---\n\n# hi\n",
      },
    },
  });
  const result = await runCanvasCli(bb, ["check", "a.canvas.mdx", "--json"], inThread);
  assert.equal(result.exitCode, 0);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report, {
    ok: true,
    diagnostics: [],
    stats: { style: "github", blocks: 1, components: [], stateIds: [] },
  });
});

test("check reports an unknown style with a suggestion and exits 1", async () => {
  const bb = fakeBb({
    threads: macThread,
    files: {
      [fileKeyOf("host_mac", undefined, "/w/a.canvas.mdx")]: {
        content: "---\nstyle: gh\n---\n\n# hi\n",
      },
    },
  });
  const result = await runCanvasCli(bb, ["check", "a.canvas.mdx"], inThread);
  assert.equal(result.exitCode, 1);
  assert.equal(
    result.stdout,
    "a.canvas.mdx:1:1: unknown style `gh`; did you mean `github`?\n1 problem\n",
  );
});

test("check lists each diagnostic as path:line:col and exits 1", async () => {
  const content = '# t\n\n<Tabel headers={["a"]} rows={[]} />\n\n<Stat label="x" value={f()} />\n';
  const bb = fakeBb({
    threads: macThread,
    files: { [fileKeyOf("host_mac", undefined, "/w/c.canvas.mdx")]: { content } },
  });
  const result = await runCanvasCli(bb, ["check", "c.canvas.mdx"], inThread);
  assert.equal(result.exitCode, 1);
  assert.equal(
    result.stdout,
    [
      "c.canvas.mdx:3:1: unknown component `Tabel`; did you mean `Table`?",
      "c.canvas.mdx:5:24: `value`: a function call is not a value a canvas can hold; write the value inline",
      "2 problems",
      "",
    ].join("\n"),
  );
});

test("check --json prints ok, diagnostics, and stats", async () => {
  const bb = fakeBb({
    threads: macThread,
    files: {
      [fileKeyOf("host_mac", undefined, "/w/c.canvas.mdx")]: {
        content: '<Toggle id="a" label="l" />\n<Toggle id="a" label="m" />\n',
      },
    },
  });
  const result = await runCanvasCli(bb, ["check", "c.canvas.mdx", "--json"], inThread);
  assert.equal(result.exitCode, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0].line, 2);
  assert.equal(report.diagnostics[0].column, 1);
  assert.match(report.diagnostics[0].message, /already used at 1:1/);
  assert.deepEqual(report.stats, {
    style: "default",
    blocks: 2,
    components: ["Toggle"],
    stateIds: ["a"],
  });
});

test("check reports a hard syntax error as one problem", async () => {
  const bb = fakeBb({
    threads: macThread,
    files: {
      [fileKeyOf("host_mac", undefined, "/w/c.canvas.mdx")]: {
        content: '<Card title="x">\n\ntext\n',
      },
    },
  });
  const result = await runCanvasCli(bb, ["check", "c.canvas.mdx"], inThread);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /^c\.canvas\.mdx:1:1: /);
  assert.match(result.stdout, /1 problem\n$/);
});

test("check fails with exit 2 when the file cannot be read", async () => {
  const result = await runCanvasCli(
    fakeBb({ threads: macThread }),
    ["check", "missing.canvas.mdx"],
    inThread,
  );
  assert.deepEqual(result, {
    exitCode: 2,
    stdout: "",
    stderr:
      "missing.canvas.mdx: missing: ENOENT: no such file or directory, open '/w/missing.canvas.mdx'\n",
  });
});

test("check --json adds the error envelope on stdout when the file cannot be read", async () => {
  const result = await runCanvasCli(
    fakeBb({ threads: macThread }),
    ["check", "missing.canvas.mdx", "--json"],
    inThread,
  );
  const message =
    "missing.canvas.mdx: missing: ENOENT: no such file or directory, open '/w/missing.canvas.mdx'";
  assert.equal(result.exitCode, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: { code: "command_failed", message },
  });
  assert.equal(result.stderr, `${message}\n`);
});

test("check without a path is a usage error that never reads a file", async () => {
  const bb = fakeBb({ threads: macThread });
  const result = await runCanvasCli(bb, ["check"]);
  assert.deepEqual(result, {
    exitCode: 1,
    stdout: "",
    stderr:
      "missing required arguments: <path>\n\nUsage:\n  bb canvas check <path> [--json] [--host <host-id>]\n",
  });
  assert.deepEqual(bb.calls.filesRead, []);
});

test("check reads a thread-storage canvas from the agent's host, not the server's", async () => {
  const root = "/Users/me/.bb/thread-storage/thr";
  const path = `${root}/canvases/a.canvas.mdx`;
  const bb = fakeBb({
    threads: macThread,
    files: { [fileKeyOf("host_mac", root, path)]: { content: "# hi\n" } },
  });
  const result = await runCanvasCli(bb, ["check", path], { cwd: "/Users/me", threadId: "thr" });
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "ok — style default, 1 block, 0 components, 0 state ids\n",
    stderr: "",
  });
  assert.deepEqual(bb.calls.filesRead, [{ hostId: "host_mac", path, rootPath: root }]);
});

test("check outside a thread needs --host and then reads from that host", async () => {
  const bb = fakeBb({
    files: { [fileKeyOf("host_mac", undefined, "/w/a.canvas.mdx")]: { content: "# hi\n" } },
  });
  assert.deepEqual(await runCanvasCli(bb, ["check", "/w/a.canvas.mdx"], { cwd: "/w" }), {
    exitCode: 1,
    stdout: "",
    stderr: "Pass --host <host-id> when running outside a thread\n",
  });
  assert.deepEqual(bb.calls.filesRead, []);
  const result = await runCanvasCli(bb, ["check", "a.canvas.mdx", "--host", "host_mac"], {
    cwd: "/w",
  });
  assert.equal(result.stdout, "ok — style default, 1 block, 0 components, 0 state ids\n");
  assert.deepEqual(bb.calls.filesRead, [{ hostId: "host_mac", path: "/w/a.canvas.mdx" }]);
});

test("check refuses a relative path without a working directory", async () => {
  const bb = fakeBb({ threads: macThread });
  assert.deepEqual(await runCanvasCli(bb, ["check", "a.canvas.mdx"], { threadId: "thr" }), {
    exitCode: 1,
    stdout: "",
    stderr: "Use absolute paths when no working directory is available\n",
  });
});
