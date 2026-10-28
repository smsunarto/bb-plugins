import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  failedJobs,
  formatElapsed,
  matrixPrefix,
  investigateMessage,
  jobCountsText,
  overallStatus,
  parseDuration,
  pipelineStatus,
  readPipeline,
  rerunMessage,
  type PipelineRun,
} from "./pipeline";
import type { Value } from "./types";

function fixture(name: string): Value {
  return JSON.parse(readFileSync(new URL(`../gallery/data/${name}`, import.meta.url), "utf8")) as Value;
}

function read(value: Value | undefined): PipelineRun {
  const result = readPipeline(value);
  if (!result.ok) throw new Error(result.error);
  return result.run;
}

const names = (run: PipelineRun) => run.stages.map((stage) => stage.jobs.map((job) => job.name));

describe("readPipeline: gh run view --json", () => {
  it("reads a failed run: header, jobs in the stages they ran in, the failing step", () => {
    const run = read(fixture("gh-run-failed.json"));
    expect(run).toMatchObject({
      source: "run",
      name: "CI",
      title: "fix(css): don't propagate rejections to later tasks in `createSerialPromiseQueue`",
      status: "failure",
      branch: "fix/serial-promise-queue-rejection",
      sha: "05edab7dc80d0bf679f3e769ca0b14b46b8cff47",
      event: "pull_request",
      url: "https://github.com/vitejs/vite/actions/runs/37986166856",
      layout: "stages",
      jobCount: 10,
    });
    // createdAt 20:19:08 → updatedAt 20:27:20.
    expect(run.ms).toBe(492_000);
    expect(jobCountsText(run.counts)).toBe("1 failed, 8 passed, 1 skipped");
    // Get changed files and Lint start together; the matrix waits for the first; the summary jobs for the matrix.
    expect(names(run)).toEqual([
      ["Get changed files", "Lint: node-24, ubuntu-latest"],
      [
        "Build&Test: node-24, macos-latest",
        "Build&Test: node-24, ubuntu-latest",
        "Build&Test: node-26, ubuntu-latest",
        "Build&Test: node-24, windows-latest",
        "Build&Test: node-20, ubuntu-latest",
        "Build&Test: node-22, ubuntu-latest",
      ],
      ["Build & Test Failed", "Build & Test Passed or Skipped"],
    ]);
    expect(run.stages.map((stage) => stage.status)).toEqual(["success", "failure", "success"]);
    const [{ job, step }] = failedJobs(run);
    expect(job.url).toBe("https://github.com/vitejs/vite/actions/runs/37986166856/job/114009293942");
    expect(job.ms).toBe(353_000);
    expect(step).toMatchObject({ name: "Test build", number: 14, status: "failure", ms: 85_000 });
    expect(job.steps[job.failedStep].name).toBe("Test build");
    // Jobs sit on one axis from the first start (20:20:51).
    expect(run.span).toBe(389_000);
    expect(run.stages[0].jobs[0].offset).toBe(1000);
  });

  it("reads a passed run, a skipped job whose completion precedes its start included", () => {
    const run = read(fixture("gh-run-passed.json"));
    expect(run.status).toBe("success");
    const skipped = run.stages.flatMap((stage) => stage.jobs).find((job) => job.name === "Build & Test Failed")!;
    expect(skipped).toMatchObject({ status: "skipped", ms: 0 });
    expect(run.stages).toHaveLength(3);
    expect(investigateMessage(run)).toBeNull();
    expect(rerunMessage(run)).toBeNull();
  });

  it("reads a running run: no total yet, the running job timed up to the newest time in the data, pending steps queued", () => {
    const run = read(fixture("gh-run-running.json"));
    expect(run).toMatchObject({ status: "in_progress", ms: null, name: "build-and-deploy" });
    const running = run.stages.flatMap((stage) => stage.jobs).find((job) => job.status === "in_progress")!;
    expect(running.name).toBe("stable - x86_64-unknown-linux-gnu - node@20");
    // Started 00:11:15; the newest time anywhere is build's completion at 00:12:16.
    expect(running.ms).toBe(61_000);
    expect(running.steps.map((step) => step.status)).toContain("in_progress");
    expect(running.steps.at(-1)).toMatchObject({ status: "queued", ms: null });
    // deploy-target, then the builds, then the native job that waited for the matrix.
    expect(run.stages.map((stage) => stage.jobs.length)).toEqual([1, 4, 1]);
  });

  it("reads `--json jobs` alone, taking the state from the jobs", () => {
    const { jobs } = fixture("gh-run-failed.json") as { jobs: Value };
    const run = read({ jobs });
    expect(run).toMatchObject({ source: "run", name: null, status: "failure", url: null });
  });
});

describe("readPipeline: gh pr checks --json", () => {
  it("groups checks by workflow, keeps two runs of one workflow apart, and puts failing groups first", () => {
    const run = read(fixture("gh-pr-checks.json"));
    expect(run).toMatchObject({ source: "checks", layout: "groups", status: "failure", jobCount: 30 });
    expect(run.stages.map((stage) => stage.name)).toEqual([
      // The data lists the later run first; runs are numbered by when they started.
      "CI · run 2 of 2",
      "CI · run 1 of 2",
      "Other checks",
      "Zizmor",
      "Semantic Pull Request",
      "CodeQL",
      "Preview release",
    ]);
    expect(run.stages[0].url).toMatch(/^https:\/\/github\.com\/vitejs\/vite\/actions\/runs\/\d+$/);
    expect(run.stages[0].jobs[0].status).toBe("failure");
    expect(run.counts).toMatchObject({ failure: 4, skipped: 3 });
    // netlify's deploy preview has no times (0001-01-01).
    const netlify = run.stages[2].jobs.find((job) => job.name === "netlify/vite-docs-main/deploy-preview")!;
    expect(netlify).toMatchObject({ startedAt: null, ms: null, offset: null });
    expect(rerunMessage(run)).toBe("Re-run the failed checks.");
  });

  it("reads bucket-only checks and running ones", () => {
    const run = read([
      { name: "build", bucket: "pass", workflow: "CI" },
      { name: "e2e", bucket: "pending", workflow: "CI" },
    ]);
    expect(run.status).toBe("in_progress");
    expect(run.ms).toBeNull();
  });
});

describe("readPipeline: a list of stages", () => {
  it("lays timed stages end to end and keeps a failing step's message", () => {
    const run = read([
      { name: "Build", status: "passed", duration: 72 },
      {
        name: "Test",
        status: "failed",
        jobs: [
          { name: "unit", status: "passed", duration: "2m 10s" },
          {
            name: "e2e",
            status: "failed",
            duration: "4m",
            url: "https://ci.example.com/jobs/9",
            steps: ["Install", { name: "Run playwright", status: "failed", duration: "3m 20s", message: "3 tests failed" }],
          },
        ],
      },
      { name: "Deploy", status: "skipped" },
    ]);
    expect(run.status).toBe("failure");
    expect(run.stages.map((stage) => [stage.name, stage.status, stage.ms])).toEqual([
      ["Build", "success", 72_000],
      ["Test", "failure", 240_000],
      ["Deploy", "skipped", null],
    ]);
    // Deploy has no duration, so the stages can't be laid end to end: bars are relative to the longest job.
    expect(run.span).toBe(240_000);
    const e2e = run.stages[1].jobs[0];
    expect(e2e).toMatchObject({ name: "e2e", url: "https://ci.example.com/jobs/9", failedStep: 1, offset: 0 });
    expect(e2e.steps[0]).toMatchObject({ name: "Install", status: "neutral" });
    expect(e2e.steps[1].message).toBe("3 tests failed");
    expect(investigateMessage(run)).toBe(
      'Find out why the CI run failed and fix it. Failed: e2e (step "Run playwright") https://ci.example.com/jobs/9',
    );
  });

  it("puts fully timed stages on one axis and reads a header object", () => {
    const run = read({
      name: "deploy",
      branch: "main",
      sha: "a1b2c3d4e5",
      stages: [
        { name: "build", status: "success", duration: 60 },
        { name: "ship", status: "running", duration: "30s" },
      ],
    });
    expect(run).toMatchObject({ name: "deploy", branch: "main", status: "in_progress", span: 90_000, ms: 90_000 });
    expect(run.stages[1].jobs[0].offset).toBe(60_000);
  });

  it("is empty for an empty list and an error for unusable input", () => {
    expect(read([])).toMatchObject({ jobCount: 0, stages: [] });
    expect(readPipeline([{ status: "passed" }])).toEqual({ ok: false, error: "Pipeline stages need a name and a status" });
    expect(readPipeline("nope").ok).toBe(false);
    expect(readPipeline(undefined).ok).toBe(false);
  });

  it("renders a half-streamed list with what is there", () => {
    const run = read([{ name: "Build", status: "passed" }, { name: "Te" }]);
    expect(run.stages.map((stage) => stage.status)).toEqual(["success", "neutral"]);
  });

  it("keeps unicode names and survives a 1,000-job run", () => {
    const jobs = Array.from({ length: 1000 }, (_, index) => ({
      name: `shard ${index} ✓ 测试`,
      status: "completed",
      conclusion: index === 999 ? "failure" : "success",
      startedAt: "2026-10-09T20:00:00Z",
      completedAt: "2026-10-09T20:01:00Z",
      steps: [],
    }));
    const run = read({ jobs });
    expect(run.jobCount).toBe(1000);
    expect(run.stages[0].jobs[0].name).toBe("shard 999 ✓ 测试");
  });
});

describe("status words and durations", () => {
  it("maps CI words to states with their detail", () => {
    expect(pipelineStatus("TIMED_OUT")).toEqual({ status: "failure", detail: "timed out" });
    expect(pipelineStatus("in progress")).toEqual({ status: "in_progress", detail: null });
    expect(pipelineStatus("canceled")).toEqual({ status: "cancelled", detail: null });
    expect(pipelineStatus("startup_failure")).toEqual({ status: "failure", detail: "startup failure" });
    expect(pipelineStatus("whatever")).toBeNull();
    expect(overallStatus(["success", "queued"])).toBe("in_progress");
    expect(overallStatus(["queued", "queued"])).toBe("queued");
    expect(overallStatus(["skipped", "skipped"])).toBe("skipped");
  });

  it("finds the name a matrix's jobs share", () => {
    expect(matrixPrefix(["Build&Test: node-24, macos-latest", "Build&Test: node-20, ubuntu-latest"])).toEqual({ label: "Build&Test", length: 12 });
    expect(matrixPrefix(["test (ubuntu, 20)", "test (windows, 22)"])).toEqual({ label: "test", length: 5 });
    expect(matrixPrefix(["e2e / chromium", "e2e / webkit"])).toEqual({ label: "e2e", length: 6 });
    expect(matrixPrefix(["build-wasm (web)", "build"])).toBeNull();
    expect(matrixPrefix(["Lint: node-24"])).toBeNull();
  });

  it("reads and writes durations", () => {
    expect(parseDuration("1m 20s")).toBe(80_000);
    expect(parseDuration("850ms")).toBe(850);
    expect(parseDuration("1.5 s")).toBe(1500);
    expect(parseDuration("01:23")).toBe(83_000);
    expect(parseDuration("1:02:03")).toBe(3_723_000);
    expect(parseDuration(42)).toBe(42_000);
    expect(parseDuration("2h 5m")).toBe(7_500_000);
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("5 apples")).toBeNull();
    expect([0, 400, 999, 45_000, 94_000, 3_900_000].map(formatElapsed)).toEqual(["0s", "<1s", "1s", "45s", "1m 34s", "1h 05m"]);
  });
});
