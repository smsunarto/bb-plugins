import { expect, test } from "vitest";
import { jobIdOf, logTail, readJobLogs } from "./job-logs.ts";

test("logTail strips timestamps and colour, and ends at the last error", () => {
  const log = [
    "2026-11-11T01:02:03.4567890Z Run bun test",
    "2026-11-11T01:02:04.0000000Z \u001B[31mFAIL\u001B[0m src/a.test.ts",
    "2026-11-11T01:02:05.0000000Z ##[error]Process completed with exit code 1.",
    "2026-11-11T01:02:06.0000000Z Post job cleanup.",
  ].join("\r\n");
  expect(logTail(log)).toBe(
    "Run bun test\nFAIL src/a.test.ts\n##[error]Process completed with exit code 1.",
  );
  expect(logTail("a\nb\nc", 2)).toBe("b\nc");
});

test("jobIdOf reads an Actions job's id from its URL, and nothing else", () => {
  expect(jobIdOf("https://github.com/o/r/actions/runs/123/job/456")).toBe(456);
  expect(jobIdOf("https://github.com/o/r/actions/runs/123/job/456?pr=7")).toBe(456);
  expect(jobIdOf("https://github.com/o/r/runs/456")).toBeNull();
  expect(jobIdOf(null)).toBeNull();
});

test("readJobLogs keeps one job's failure from failing the others", async () => {
  const calls: string[] = [];
  const logs = await readJobLogs(
    async (args) => {
      calls.push(args.join(" "));
      return args[1]!.includes("/1/")
        ? { code: 0, stdout: "boom\n##[error]bad", stderr: "" }
        : { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    },
    { owner: "o", name: "r" },
    [1, 2],
  );
  expect(calls).toEqual(["api repos/o/r/actions/jobs/1/logs", "api repos/o/r/actions/jobs/2/logs"]);
  expect(logs[0]).toEqual({ jobId: 1, text: "boom\n##[error]bad", missing: null });
  expect(logs[1]).toMatchObject({ jobId: 2, text: null });
  expect(logs[1]!.missing).toBeTruthy();
});

test("readJobLogs asks gh for escape sequences only when gh refuses without, and strips them", async () => {
  const calls: string[][] = [];
  const logs = await readJobLogs(
    async (args) => {
      calls.push([...args]);
      return args.includes("--allow-escape-sequences")
        ? {
            code: 0,
            stdout:
              "\u001B]8;;https://x\u0007link\u001B]8;;\u0007 \u001B[1;31mred\u001B[0m\n##[error]x",
            stderr: "",
          }
        : {
            code: 1,
            stdout: "",
            stderr:
              "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway",
          };
    },
    { owner: "o", name: "r" },
    [1],
  );
  expect(calls.map((args) => args.at(-1))).toEqual([
    "repos/o/r/actions/jobs/1/logs",
    "--allow-escape-sequences",
  ]);
  expect(logs[0]).toEqual({ jobId: 1, text: "link red\n##[error]x", missing: null });
});
