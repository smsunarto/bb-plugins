import { describe, expect, test } from "bun:test";
import type { Check } from "../shared/schema.ts";
import { checkDuration, checksRunning, groupChecks } from "./checks.tsx";
import { checkNames, fixDraftKey } from "./fix-dialog.tsx";

function check(id: string, state: Check["state"], extra: Partial<Check> = {}): Check {
  return {
    id,
    name: id,
    workflow: "CI",
    state,
    description: null,
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    jobId: null,
    ...extra,
  };
}

describe("groupChecks", () => {
  test("puts failures first and folds skipped, neutral, and cancelled together", () => {
    const groups = groupChecks([
      check("lint", "success"),
      check("deploy", "skipped"),
      check("build", "failure"),
      check("e2e", "pending"),
      check("docs", "neutral"),
      check("bench", "cancelled"),
      check("test", "failure"),
    ]);
    expect(groups.map((group) => [group.title, group.checks.map((c) => c.id)])).toEqual([
      ["Failing", ["build", "test"]],
      ["In progress", ["e2e"]],
      ["Passed", ["lint"]],
      ["Skipped, neutral, or cancelled", ["deploy", "docs", "bench"]],
    ]);
  });

  test("leaves out groups with no checks", () => {
    expect(groupChecks([check("lint", "success")]).map((group) => group.id)).toEqual(["passed"]);
    expect(groupChecks([])).toEqual([]);
  });
});

describe("checksRunning", () => {
  test("is true while the rollup or any one check is pending", () => {
    expect(checksRunning({ headRefOid: "a", state: "pending", checks: [] })).toBe(true);
    expect(checksRunning({ headRefOid: "a", state: null, checks: [check("e2e", "pending")] })).toBe(
      true,
    );
  });

  test("is false once every check has finished, or before the first read", () => {
    expect(
      checksRunning({ headRefOid: "a", state: "failure", checks: [check("build", "failure")] }),
    ).toBe(false);
    expect(checksRunning(undefined)).toBe(false);
  });
});

describe("checkDuration", () => {
  const at = (startedAt: string | null, completedAt: string | null) =>
    checkDuration({ startedAt, completedAt });

  test("reads seconds, minutes, and hours the way CI logs do", () => {
    expect(at("2026-10-09T10:00:00Z", "2026-10-09T10:00:45Z")).toBe("45s");
    expect(at("2026-10-09T10:00:00Z", "2026-10-09T10:02:05Z")).toBe("2m 05s");
    expect(at("2026-10-09T10:00:00Z", "2026-10-09T11:12:40Z")).toBe("1h 12m");
  });

  test("is null for a check that has not finished or has unreadable times", () => {
    expect(at("2026-10-09T10:00:00Z", null)).toBeNull();
    expect(at(null, "2026-10-09T10:00:00Z")).toBeNull();
    expect(at("2026-10-09T10:05:00Z", "2026-10-09T10:00:00Z")).toBeNull();
    expect(at("soon", "later")).toBeNull();
  });
});

describe("fix drafts", () => {
  const pr = { ref: { owner: "acme", repo: "api", number: 7 }, headRefOid: "abc123" };

  test("one draft per pull request head and set of checks, in any order", () => {
    expect(fixDraftKey(pr, ["run:2", "run:1"])).toBe(
      "code-review-fix:acme/api#7@abc123:run:1,run:2",
    );
    expect(fixDraftKey(pr, ["run:1", "run:2"])).toBe(fixDraftKey(pr, ["run:2", "run:1"]));
    expect(fixDraftKey({ ...pr, headRefOid: "def456" }, ["run:1"])).not.toBe(
      fixDraftKey(pr, ["run:1"]),
    );
  });

  test("names the checks being fixed, shortening a long list", () => {
    expect(checkNames([{ name: "build" }])).toBe("build");
    expect(checkNames([{ name: "build" }, { name: "lint" }])).toBe("build and lint");
    expect(checkNames([{ name: "build" }, { name: "lint" }, { name: "test" }])).toBe(
      "build, lint, and test",
    );
    expect(
      checkNames([{ name: "build" }, { name: "lint" }, { name: "test" }, { name: "e2e" }]),
    ).toBe("build, lint, and 2 more");
  });
});
