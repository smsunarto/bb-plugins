import { expect, test } from "bun:test";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fakeContext } from "../../../test/fake-gh.ts";
import { reportFindings } from "./report-findings.ts";

const REF = { owner: "cli", repo: "cli", number: 9000 };

test("only review threads the panel started get the tool", () => {
  const { ctx } = fakeContext();
  const enabled = (pluginMetadata: Record<string, string>) =>
    reportFindings.enabled!(ctx, makePluginAgentConfigurationContext({ pluginMetadata }));
  expect(enabled({ kind: "review", pr: "cli/cli#9000" })).toBe(true);
  expect(enabled({ kind: "fix", pr: "cli/cli#9000" })).toBe(false);
  expect(enabled({ kind: "review" })).toBe(false);
  expect(enabled({})).toBe(false);
});

test("stores the findings against the reviewed commit and base, and tells open panels", async () => {
  const { ctx, harness } = fakeContext();
  await ctx.store.addLink(REF, {
    threadId: "thr_review",
    kind: "review",
    createdAt: "2026-10-01T00:00:00.000Z",
    headRefOid: "cc36d32",
    baseRefName: "trunk",
  });
  const tool = { threadId: "thr_review", projectId: "p-cli", signal: new AbortController().signal };

  const result = await reportFindings.execute(
    { ...ctx, tool },
    {
      summary: "  One real bug.  ",
      findings: [
        {
          priority: 1,
          title: "Check the flag before reading it",
          body: "Nil flag panics.",
          path: "a.go",
          line: 20,
          startLine: 18,
        },
        {
          priority: 3,
          title: "Drop the dead branch",
          body: "Unreachable.",
          path: "b.go",
          line: 4,
          startLine: 9,
          side: "LEFT",
        },
        {
          priority: 2,
          title: "Close the file",
          body: "Leaks.",
          path: "c.go",
          line: 7,
          startLine: 7,
        },
      ],
    },
  );

  expect(result).toBe("Reported 3 findings on cli/cli#9000.");
  const run = await ctx.store.run("thr_review");
  expect(run).toMatchObject({
    threadId: "thr_review",
    headRefOid: "cc36d32",
    baseRefName: "trunk",
    summary: "One real bug.",
  });
  expect(run?.findings).toEqual([
    {
      id: "f1",
      priority: 1,
      title: "Check the flag before reading it",
      body: "Nil flag panics.",
      path: "a.go",
      line: 20,
      startLine: 18,
      side: "RIGHT",
    },
    // A range given backwards is read forwards.
    {
      id: "f2",
      priority: 3,
      title: "Drop the dead branch",
      body: "Unreachable.",
      path: "b.go",
      line: 9,
      startLine: 4,
      side: "LEFT",
    },
    {
      id: "f3",
      priority: 2,
      title: "Close the file",
      body: "Leaks.",
      path: "c.go",
      line: 7,
      startLine: null,
      side: "RIGHT",
    },
  ]);
  expect(harness.inspection.realtimeSignals).toEqual([
    { channel: "agent-activity", payload: { key: "cli/cli#9000" } },
  ]);
});

test("a thread the panel did not start has nowhere to report to", async () => {
  const { ctx } = fakeContext();
  const tool = { threadId: "thr_other", projectId: "p", signal: new AbortController().signal };
  await expect(
    reportFindings.execute({ ...ctx, tool }, { summary: "", findings: [] }),
  ).rejects.toThrow("This thread is not a Code Review review, so there is nowhere to report to.");
});

test("a finding outside the schema is rejected before it is stored", () => {
  const finding = { priority: 4, title: "x", body: "", path: "a", line: 1 };
  expect(reportFindings.parameters.safeParse({ summary: "", findings: [finding] }).success).toBe(
    false,
  );
  expect(
    reportFindings.parameters.safeParse({ summary: "", findings: [{ ...finding, priority: 0 }] })
      .success,
  ).toBe(true);
});
