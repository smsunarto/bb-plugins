import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeContext } from "../fake-context.ts";
import { removeSkill } from "./remove-skill.ts";

test("makes stale skill removal an expected outcome", async () => {
  const missing = createFakeContext();
  assert.deepEqual(await removeSkill.handler(missing, { name: "example" }), {
    outcome: "not-found",
  });

  const logs: string[] = [];
  const existing = createFakeContext(
    {
      discoverSkills: () => [
        {
          path: ".dotfiles/.agents/skills/example/SKILL.md",
          title: "example",
        },
      ],
    },
    {
      log: (message) => {
        logs.push(message);
      },
    },
  );
  assert.deepEqual(await removeSkill.handler(existing, { name: "example" }), {
    outcome: "completed",
    exitCode: 0,
    output: "removed",
  });
  assert.deepEqual(logs, ["removing skill example via npx skills"]);
  await assert.rejects(
    async () => removeSkill.handler(existing, { name: "../example" }),
    /invalid skill name/,
  );
});
