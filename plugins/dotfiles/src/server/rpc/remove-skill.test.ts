import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import { createFakeContext } from "../fake-context.ts";
import { removeSkill } from "./remove-skill.ts";

test("makes stale skill removal an expected outcome", async () => {
  const missing = createFakeContext();
  assert.deepEqual(await removeSkill.execute(missing, { name: "example" }), {
    outcome: "not-found",
  });

  const log = mock<(message: string) => void>();
  const existing = createFakeContext(
    {
      discoverSkills: () => [
        {
          path: ".dotfiles/.agents/skills/example/SKILL.md",
          title: "example",
        },
      ],
    },
    { log },
  );
  assert.deepEqual(await removeSkill.execute(existing, { name: "example" }), {
    outcome: "completed",
    exitCode: 0,
    output: "removed",
  });
  assert.deepEqual(log.mock.calls, [["removing skill example via npx skills"]]);
  await assert.rejects(
    async () => removeSkill.execute(existing, { name: "../example" }),
    /invalid skill name/,
  );
});
