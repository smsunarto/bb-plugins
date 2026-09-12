import { test, expect } from "bun:test";
import { fakeBb, fileKeyOf } from "../fake-bb.ts";
import { generate } from "./generate.ts";
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
const input = { template: "review" as const, data: "data.json", out: "result.canvas.mdx" };

test("generate routes reads and writes to the thread host", async () => {
  const bb = fixture();
  const result = await generate.execute({ bb, cwd: "/work", threadId: "t" }, input);
  expect(result.exitCode).toBe(0);
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
    await expect(generate.execute({ bb, cwd: "/work", threadId: "t" }, input)).rejects.toThrow();
    expect(bb.calls.filesWrite).toHaveLength(0);
  }
});

test("existing output is preserved", async () => {
  const bb = fixture(JSON.stringify(data), true);
  await expect(generate.execute({ bb, cwd: "/work", threadId: "t" }, input)).rejects.toThrow(
    "already exists",
  );
  expect(bb.store.get(fileKeyOf("remote", undefined, "/work/result.canvas.mdx"))).toMatchObject({
    content: "# Existing\n",
  });
});

test("outside a thread an explicit host is required", async () => {
  const bb = fixture();
  await expect(generate.execute({ bb, cwd: "/work" }, input)).rejects.toThrow("--host");
  expect(
    (await generate.execute({ bb, cwd: "/work" }, { ...input, host: "remote" })).exitCode,
  ).toBe(0);
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

test("missing required options fail before host IO", async () => {
  const bb = fixture();
  await expect(generate.execute({ bb }, { template: "review" })).rejects.toThrow(
    "--data and --out",
  );
  expect(bb.calls.filesRead).toHaveLength(0);
});
