import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  deriveBranchName,
  isBranchCandidate,
  normalizeBranchPrefix,
} from "../lib/branch-name.ts";

test("deriveBranchName applies the same naming policy to UI and server callers", () => {
  assert.equal(deriveBranchName("Add rate limiting to the API", false), "add-rate-limiting-api");
  assert.equal(
    deriveBranchName("feat(api)!: add rate limiting to the API", true),
    "feat-add-rate-limiting-api",
  );
  assert.equal(deriveBranchName("Add rate limiting", true), "add-rate-limiting");
  assert.equal(deriveBranchName("the and to", false), "");
});

// The branch carries the type but not the scope: a scope names the area the
// slug already describes, so repeating it only lengthens the ref.
test("deriveBranchName keeps the type and drops the scope", () => {
  assert.equal(
    deriveBranchName("feat(api): add rate limiting", true),
    "feat-add-rate-limiting",
  );
  assert.equal(
    deriveBranchName("fix(gh-stack): stop double counting", true),
    "fix-stop-double-counting",
  );
  // A scope with punctuation or spaces still leaves the slug untouched.
  assert.equal(
    deriveBranchName("refactor(plugins/amp): split provisioning", true),
    "refactor-split-provisioning",
  );
  // Without the setting, the whole title slugifies — scope included.
  assert.equal(
    deriveBranchName("feat(api): add rate limiting", false),
    "feat-api-add-rate-limiting",
  );
});

test("normalizeBranchPrefix trims and adds a namespace separator", () => {
  assert.deepEqual(normalizeBranchPrefix(" scott "), { prefix: "scott/" });
  assert.deepEqual(normalizeBranchPrefix("team_"), { prefix: "team_" });
  assert.deepEqual(normalizeBranchPrefix("/team/"), { prefix: "team/" });
  assert.deepEqual(normalizeBranchPrefix(""), { prefix: "" });
});

test("branch candidate preflight rejects flags and unsupported characters", () => {
  assert.equal(isBranchCandidate("team/feature"), true);
  assert.equal(isBranchCandidate("-danger"), false);
  assert.equal(isBranchCandidate("team feature"), false);
  assert.equal(isBranchCandidate("team@feature"), false);
});

test("git check-ref-format rejects structurally invalid normalized prefixes", () => {
  const invalidPrefixes = [
    "foo..bar",
    "foo//",
    "foo/.hidden",
    "foo.lock",
    "foo.",
  ];
  for (const raw of invalidPrefixes) {
    const normalized = normalizeBranchPrefix(raw);
    if ("error" in normalized) {
      assert.equal(raw, "foo.");
      continue;
    }
    const result = spawnSync(
      "git",
      ["check-ref-format", "--branch", `${normalized.prefix}bb-stack-check`],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, `${raw} unexpectedly formed a valid branch`);
  }

  const valid = normalizeBranchPrefix("team/platform");
  assert.ok("prefix" in valid);
  assert.equal(
    spawnSync("git", ["check-ref-format", "--branch", `${valid.prefix}bb-stack-check`])
      .status,
    0,
  );
});
