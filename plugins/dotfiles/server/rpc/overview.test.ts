import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeContext } from "../fake-context.ts";
import { overview } from "./overview.ts";

test("builds the overview from static files, discovered skills, and git state", async () => {
  const ctx = createFakeContext({
    discoverSkills: () => [
      {
        path: ".dotfiles/.agents/skills/example/SKILL.md",
        title: "example",
      },
    ],
    gitStatus: async () => ({
      branch: "feature",
      entries: [{ status: "M", path: ".dotfiles/mcp.json" }],
    }),
    pathExists: (_repoPath, path) => path !== "mise.linux.toml",
  });

  const result = await overview.execute(ctx);

  assert.equal(result.repoPath, "/dotfiles");
  assert.equal(result.repoExists, true);
  assert.equal(result.branch, "feature");
  assert.deepEqual(result.groups.at(-1), {
    id: "skills",
    title: "Skills",
    files: [
      {
        path: ".dotfiles/.agents/skills/example/SKILL.md",
        title: "example",
        exists: true,
        dirty: false,
      },
    ],
  });
  assert.equal(result.groups[0]?.files[0]?.dirty, true);
  assert.equal(
    result.groups.flatMap((group) => group.files).find((file) => file.path === "mise.linux.toml")
      ?.exists,
    false,
  );
});

test("returns a stable missing-repository overview", async () => {
  const ctx = createFakeContext({
    repoExists: () => false,
    discoverSkills: () => {
      throw new Error("must not scan a missing repository");
    },
  });

  const result = await overview.execute(ctx);

  assert.equal(result.repoExists, false);
  assert.equal(result.branch, "missing");
  assert.deepEqual(result.gitEntries, []);
  assert.deepEqual(result.groups.at(-1)?.files, []);
});
