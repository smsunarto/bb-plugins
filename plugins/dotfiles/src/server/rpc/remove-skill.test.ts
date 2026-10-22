import { test } from "bun:test";
import assert from "node:assert/strict";
import { createFakeContext } from "../fake-context.ts";
import { cleanRepo } from "../fake-git.ts";
import type { Repo } from "../git.ts";
import { removeSkill } from "./remove-skill.ts";

test("makes stale skill removal an expected outcome", async () => {
  const missing = createFakeContext();
  assert.deepEqual(await removeSkill.execute(missing, { name: "example" }), {
    outcome: "not-found",
  });

  const removed: string[] = [];
  const existing = createFakeContext({
    inspect: async (target) =>
      cleanRepo(target, {
        skills: [{ path: ".dotfiles/.agents/skills/example/SKILL.md", title: "example" }],
      }),
    removeSkill: async (repo: Repo, name: string) => {
      removed.push(`${repo.hostId} ${name}`);
      return { exitCode: 0, output: "removed" };
    },
  });
  assert.deepEqual(await removeSkill.execute(existing, { hostId: "host_mac", name: "example" }), {
    outcome: "completed",
    exitCode: 0,
    output: "removed",
  });
  assert.deepEqual(removed, ["host_mac example"]);
  assert.deepEqual(existing.harness.logEntries, [
    { level: "info", message: "removing skill example on Local Mac via npx skills" },
  ]);
  await assert.rejects(
    async () => removeSkill.execute(existing, { name: "../example" }),
    /invalid skill name/,
  );
});
