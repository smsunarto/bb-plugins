import { test, expect } from "bun:test";
import { fakeBb, fileKeyOf, runCanvasCli } from "../fake-bb.ts";
import { generateCanvas } from "../lib/generate.ts";

const data = {
  title: "Review",
  summary: "- First\n- Second",
  sections: [{ title: 'Quotes " & braces {}', body: "Actual evidence.", collapsible: true }],
};

test("Eta preserves Markdown newlines and serializes JSX title props", () => {
  const output = generateCanvas("review", data);
  expect(output).toContain("- First\n- Second\n");
  expect(output).toContain('title={"Quotes \\" & braces {}"}');
  expect(output).toContain("defaultOpen={false}");
  expect(output).not.toContain("<% ");
});

test("JSON content is not evaluated as Eta code", () => {
  expect(
    generateCanvas("review", { title: "Review", summary: '`<%= throw new Error("executed") %>`' }),
  ).toContain("throw new Error");
});

test("invalid components and nonliteral props are rejected", () => {
  for (const summary of ["<Unknown />", '<Stat label="x" value={run()} />']) {
    expect(() => generateCanvas("review", { title: "Review", summary })).toThrow();
  }
});

test("unsupported fields are rejected rather than silently dropped", () => {
  expect(() => generateCanvas("issue", data)).toThrow();
  expect(() => generateCanvas("review", { ...data, steps: ["one"] })).toThrow();
  expect(() => generateCanvas("review", { ...data, typo: true })).toThrow();
});

function fixture(content = JSON.stringify(data), existing = false) {
  return fakeBb({
    threads: { t: { hostId: "remote", storageRootPath: "/storage/t" } },
    files: {
      [fileKeyOf("remote", undefined, "/work/data.json")]: { content },
      ...(existing
        ? {
            [fileKeyOf("remote", undefined, "/work/result.canvas.mdx")]: {
              content: "# Existing\n",
            },
          }
        : {}),
    },
  });
}
const argv = ["generate", "review", "--data", "data.json", "--out", "result.canvas.mdx"];
const inThread = { cwd: "/work", threadId: "t" };

test("generate routes reads and writes to the thread host", async () => {
  const bb = fixture();
  const result = await runCanvasCli(bb, argv, inThread);
  expect(result).toEqual({
    exitCode: 0,
    stdout: "ok — generated /work/result.canvas.mdx\n",
    stderr: "",
  });
  expect(bb.calls.filesRead).toEqual([{ hostId: "remote", path: "/work/data.json" }]);
  expect(bb.calls.filesWrite[0]).toMatchObject({
    hostId: "remote",
    path: "/work/result.canvas.mdx",
    expectedSha256: null,
  });
});

test("generation failures never write an output file", async () => {
  for (const content of ["not json", JSON.stringify({ title: "Bad", summary: "<Unknown />" })]) {
    const bb = fixture(content);
    expect((await runCanvasCli(bb, argv, inThread)).exitCode).toBe(1);
    expect(bb.calls.filesWrite).toHaveLength(0);
  }
});

test("existing output is preserved", async () => {
  const bb = fixture(JSON.stringify(data), true);
  expect(await runCanvasCli(bb, argv, inThread)).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "/work/result.canvas.mdx already exists; choose a new output path\n",
  });
  expect(bb.store.get(fileKeyOf("remote", undefined, "/work/result.canvas.mdx"))).toMatchObject({
    content: "# Existing\n",
  });
});

test("outside a thread an explicit host is required", async () => {
  const bb = fixture();
  expect(await runCanvasCli(bb, argv, { cwd: "/work" })).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "Pass --host <host-id> when running outside a thread\n",
  });
  expect(await runCanvasCli(bb, [...argv, "--host", "remote", "--json"], { cwd: "/work" })).toEqual(
    {
      exitCode: 0,
      stdout: '{"path":"/work/result.canvas.mdx","hostId":"remote","template":"review"}\n',
      stderr: "",
    },
  );
});

test("issue sections are conditional and numbered steps preserve order", () => {
  const output = generateCanvas("issue", {
    title: "Issue",
    summary: "Summary",
    steps: ["First", "Second"],
    expected: "Expected result",
  });
  expect(output).toContain("1. First\n2. Second\n");
  expect(output).toContain("## Expected\n\nExpected result");
  expect(output).not.toContain("## Actual");
});

test("missing required options and unknown templates fail before host IO", async () => {
  const bb = fixture();
  expect(await runCanvasCli(bb, ["generate", "review"])).toEqual({
    exitCode: 1,
    stdout: "",
    stderr:
      "missing required options: --data, --out\n\nUsage:\n  bb canvas generate <template> --data <file> --out <file> [--host <host-id>] [--json]\n",
  });
  expect(
    await runCanvasCli(bb, ["generate", "memo", "--data", "d.json", "--out", "o.canvas.mdx"]),
  ).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "invalid value 'memo' for <template>. Expected one of: review, issue, pull-request\n",
  });
  expect(bb.calls.filesRead).toHaveLength(0);
});
