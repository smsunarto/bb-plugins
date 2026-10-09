import { expect, test } from "bun:test";
import { fakeGh, fixture, fixtureText } from "../../../test/fake-gh.ts";
import { type GqlChecks, jobLogTail, loadChecks, logTail, mapCheck } from "./checks.ts";

const API = { owner: "acme", repo: "api", number: 1034 };

test("reads recorded checks: failures first, then the rest by name, with job ids only for Actions jobs", async () => {
  const { gh } = fakeGh({ graphql: { Checks: fixture("checks-acme-api-1034.json") } });

  const checks = await loadChecks(gh, API);

  expect(checks.headRefOid).toBe("423b69654005c318d92687f191a3b8f473043c25");
  expect(checks.state).toBe("failure");
  expect(checks.checks.map((c) => [c.name, c.workflow, c.state, c.jobId])).toEqual([
    ["Lint", "CI", "failure", 110959498696],
    ["Test", "CI", "failure", 110959498281],
    ["cubic · AI code reviewer", "cubic-dev-ai", "neutral", null],
    ["Lint (PR Title)", "PR", "success", 110959522353],
    ["Macroscope - Correctness Check", "MacroscopeApp", "skipped", null],
    ["Qodana", "CI", "success", 110959498726],
    // A check run an Actions step created through the API: it has no job log.
    ["Qodana for Go", "CI", "neutral", null],
  ]);
  expect(checks.checks[0]).toEqual({
    id: "run:110959498696",
    name: "Lint",
    workflow: "CI",
    state: "failure",
    description: null,
    detailsUrl: "https://github.com/acme/api/actions/runs/37043618707/job/110959498696",
    startedAt: "2026-10-02T17:52:18Z",
    completedAt: "2026-10-02T17:55:48Z",
    jobId: 110959498696,
  });
});

test("a commit with no checks has no state", async () => {
  const data = fixture<GqlChecks>("checks-acme-api-1034.json");
  const commit = data.repository.pullRequest.commits.nodes[0]!.commit;
  commit.statusCheckRollup = null;
  const { gh } = fakeGh({ graphql: { Checks: data } });

  expect(await loadChecks(gh, API)).toEqual({
    headRefOid: "423b69654005c318d92687f191a3b8f473043c25",
    state: null,
    checks: [],
  });
});

test("checks past the first hundred are fetched from the head commit", async () => {
  const data = fixture<GqlChecks>("checks-acme-api-1034.json");
  const commit = data.repository.pullRequest.commits.nodes[0]!.commit;
  commit.statusCheckRollup!.contexts.pageInfo = { hasNextPage: true, endCursor: "c100" };
  const more = {
    __typename: "StatusContext",
    context: "ci/legacy",
    state: "PENDING",
    targetUrl: "https://ci.example.com/1",
    description: "Waiting",
    createdAt: "2026-10-02T17:52:00Z",
  };
  const { gh, calls } = fakeGh({
    graphql: {
      Checks: data,
      CheckContexts: {
        node: {
          statusCheckRollup: {
            contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [more] },
          },
        },
      },
    },
  });

  const checks = await loadChecks(gh, API);

  expect(calls[1]).toEqual({
    kind: "graphql",
    operation: "CheckContexts",
    variables: { id: commit.id, after: "c100" },
  });
  expect(checks.checks.map((c) => c.name).slice(0, 3)).toEqual(["Lint", "Test", "ci/legacy"]);
  expect(checks.checks[2]).toEqual({
    id: "status:ci/legacy",
    name: "ci/legacy",
    workflow: null,
    state: "pending",
    description: "Waiting",
    detailsUrl: "https://ci.example.com/1",
    startedAt: "2026-10-02T17:52:00Z",
    completedAt: null,
    jobId: null,
  });
});

test("a check run reads by its status, then its conclusion", () => {
  const run = (status: string, conclusion: string | null) =>
    mapCheck({
      __typename: "CheckRun",
      databaseId: 1,
      name: "build",
      status,
      conclusion,
      detailsUrl: null,
      startedAt: null,
      completedAt: null,
      title: "",
      checkSuite: null,
    }).state;
  expect([
    run("IN_PROGRESS", null),
    run("QUEUED", null),
    run("COMPLETED", "TIMED_OUT"),
    run("COMPLETED", "STARTUP_FAILURE"),
    run("COMPLETED", "ACTION_REQUIRED"),
    run("COMPLETED", "STALE"),
    run("COMPLETED", "CANCELLED"),
    run("COMPLETED", "SKIPPED"),
  ]).toEqual([
    "pending",
    "pending",
    "failure",
    "failure",
    "failure",
    "cancelled",
    "cancelled",
    "skipped",
  ]);
});

test("a log tail ends at the last error, without timestamps, colour, or post-job cleanup", () => {
  expect(logTail(fixtureText("job-log.txt"), 8)).toBe(
    [
      "##[error]internal/systems/resolve_test.go:181:18: assignment mismatch: 2 variables but UpgradeCommand{…}.MarshalWire returns 1 value (typecheck)",
      "package system",
      "1 issues:",
      "* typecheck: 1",
      'task: Failed to run task "lint": task: Failed to run task "_lint:go": exit status 1',
      '##[error]task: Failed to run task "_lint:go": exit status 1',
      "",
      "##[error]Process completed with exit code 201.",
    ].join("\n"),
  );
  expect(logTail("a\nb\nc", 2)).toBe("b\nc");
});

test("a job's log is read through the REST logs endpoint", async () => {
  const { gh, calls } = fakeGh({
    rest: { "repos/acme/api/actions/jobs/7/logs": fixtureText("job-log.txt") },
  });

  const tail = await jobLogTail(gh, API, 7);

  expect(calls).toEqual([
    { kind: "rest", method: "GET", path: "repos/acme/api/actions/jobs/7/logs" },
  ]);
  expect(tail.split("\n").at(-1)).toBe("##[error]Process completed with exit code 201.");
});
