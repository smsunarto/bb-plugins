import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveWorkspaceKey } from "../lib/workspace-key.ts";

test("workspace key resolves Git's common directory canonically", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gh-stack-workspace-"));
  const gitDir = join(cwd, ".git");
  mkdirSync(gitDir);
  const result = await resolveWorkspaceKey(cwd, async (args, actualCwd) => {
    assert.deepEqual(args, ["rev-parse", "--git-common-dir"]);
    assert.equal(actualCwd, cwd);
    return {
      code: 0,
      stdout: ".git\n",
      stderr: "",
      failedToSpawn: false,
      timedOut: false,
    };
  });
  assert.deepEqual(result, { key: realpathSync(gitDir), error: null });
});

test("workspace key failure cannot fall back to the worktree path", async () => {
  const result = await resolveWorkspaceKey("/worktree-a", async () => ({
    code: 128,
    stdout: "",
    stderr: "fatal: not a git repository\n",
    failedToSpawn: false,
    timedOut: false,
  }));
  assert.equal(result.key, null);
  assert.match(result.error ?? "", /not a git repository/i);

  let mutationRan = false;
  if (result.key) mutationRan = true;
  assert.equal(mutationRan, false);
});

test("workspace key reports missing Git without inventing an identity", async () => {
  const result = await resolveWorkspaceKey("/worktree-a", async () => ({
    code: 1,
    stdout: "",
    stderr: "",
    failedToSpawn: true,
    timedOut: false,
  }));
  assert.deepEqual(result, {
    key: null,
    error: "The git CLI was not found on the BB server host.",
  });
});

test("workspace key fails closed when Git names a missing common directory", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gh-stack-workspace-"));
  const result = await resolveWorkspaceKey(cwd, async () => ({
    code: 0,
    stdout: ".missing-git-dir\n",
    stderr: "",
    failedToSpawn: false,
    timedOut: false,
  }));
  assert.deepEqual(result, {
    key: null,
    error: "Git's repository common directory does not exist on the BB server host.",
  });
});
