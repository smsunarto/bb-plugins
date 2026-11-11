import { Effect } from "effect";
import { expect, test } from "vitest";
import type { CheckRow, ChecksValue, Facet, ForgeValue, PullRequest } from "../core/change.ts";
import { changeKeySchema } from "../core/ids.ts";
import type { JobLog } from "../forge/job-logs.ts";
import { createFixChecks } from "./fix-checks.ts";
import type { ForgeSites } from "./forge-sites.ts";
import type { Store } from "./store.ts";

const key = changeKeySchema.parse("gh:smsunarto/bb-plugins:smsunarto:scott/fix");
const head = "abc1234def5678";

const pr: PullRequest = {
  number: 7,
  url: "https://github.com/smsunarto/bb-plugins/pull/7",
  title: "Fix things",
  state: "open",
  isDraft: false,
  headRefOid: head,
  baseRef: "main",
  reviewDecision: null,
  approvals: 0,
  mergeable: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  commits: 1,
  checks: { passed: 0, failed: 4, pending: 0 },
};

const failed = (name: string, job: number | null): CheckRow => ({
  name,
  workflow: "CI",
  outcome: "failed",
  url: job ? `https://github.com/smsunarto/bb-plugins/actions/runs/1/job/${job}` : null,
  startedAt: null,
  completedAt: null,
});

function setup(rows: CheckRow[], logs: (ids: number[]) => JobLog[]) {
  const asked: number[][] = [];
  const spawned: Record<string, unknown>[] = [];
  const store = {
    checkouts: () => [],
    forge: (): Facet<ForgeValue> => ({ read: { value: pr, at: 1 }, problem: null }),
    checks: (): Facet<ChecksValue> => ({
      read: { value: { head, rows, more: false }, at: 1 },
      problem: null,
    }),
  } as unknown as Store;
  const sites = {
    jobLogs: ({ jobIds }: { jobIds: number[] }) => {
      asked.push(jobIds);
      return Effect.succeed(logs(jobIds));
    },
  } as unknown as ForgeSites;
  const bb = {
    sdk: {
      projects: { list: async () => [] },
      threads: {
        spawn: async (args: Record<string, unknown>) => {
          spawned.push(args);
          return { id: "thr_fix" };
        },
      },
    },
  } as never;
  return { fix: createFixChecks({ bb, store, sites }), asked, spawned };
}

test("the prompt reads at most three logs and says why each other one is missing", async () => {
  const { fix, asked } = setup(
    [failed("a", 1), failed("b", 2), failed("c", 3), failed("d", 4), failed("status", null)],
    (ids) => ids.map((jobId) => ({ jobId, text: `log of ${jobId}`, missing: null })),
  );
  const answer = await Effect.runPromise(
    fix.prompt(key, head, ["CI:a", "CI:b", "CI:c", "CI:d", "CI:status"]),
  );
  expect(asked).toEqual([[1, 2, 3]]);
  if (!answer.ok) throw new Error(answer.message);
  expect(answer.prompt).toContain("smsunarto/bb-plugins#7: Fix things");
  expect(answer.prompt).toContain("git switch -c 'source-control/fix-7-abc1234' FETCH_HEAD");
  expect(answer.prompt).toContain("log of 3");
  expect(answer.prompt).toContain("### CI / d");
  expect(answer.prompt).toContain("No log: not fetched; open the URL.");
  expect(answer.prompt).toContain("No log: not a GitHub Actions job.");
  // No bb project for the repository: the composer picks one.
  expect(answer.projectId).toBeNull();
  expect(answer.environment).toBeNull();
});

test("a head the checks are not on reads nothing and starts nothing", async () => {
  const { fix, asked, spawned } = setup([failed("a", 1)], () => []);
  const answer = await Effect.runPromise(fix.prompt(key, "0000000", ["CI:a"]));
  expect(answer).toMatchObject({ ok: false });
  expect(asked).toEqual([]);
  const request = { projectId: "p", providerId: "codex", environment: { type: "x" }, input: [] };
  expect(await fix.start(key, "0000000", request)).toMatchObject({ ok: false });
  expect(spawned).toEqual([]);
  expect(await fix.start(key, head, request)).toEqual({ ok: true, threadId: "thr_fix" });
  expect(spawned[0]).toMatchObject({
    title: "Fix checks on smsunarto/bb-plugins#7",
    pluginMetadata: { kind: "fix", changeKey: key, head },
  });
});
