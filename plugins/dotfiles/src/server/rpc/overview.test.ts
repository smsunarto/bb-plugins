import { test } from "bun:test";
import assert from "node:assert/strict";
import { createFakeContext } from "../fake-context.ts";
import { cleanRepo, missingRepo } from "../fake-git.ts";
import { overview } from "./overview.ts";

test("builds the overview from static files, discovered skills, and git state", async () => {
  const ctx = createFakeContext({
    inspect: async (target) =>
      cleanRepo(target, {
        branch: "feature",
        entries: [
          { status: "M", path: ".dotfiles/mcp.json" },
          {
            status: "M",
            path: ".dotfiles/.agents/plugins/scott-engineering/skills/dev/playbooks/feature.md",
          },
        ],
        skills: [
          { path: ".dotfiles/.agents/skills/example/SKILL.md", title: "example" },
          { path: ".dotfiles/.agents/skills/Foo_Bar/SKILL.md", title: "Foo_Bar" },
        ],
        missingPaths: [
          "mise.linux.toml",
          ".dotfiles/.agents/plugins/scott-engineering/skills/dev/playbooks/bug-fix.md",
        ],
      }),
  });

  const result = await overview(ctx, {});

  assert.equal(result.state, "ready");
  if (result.state !== "ready") return;
  assert.deepEqual(result.host, { id: "host_server", name: "linux-builder" });
  assert.equal(result.repoPath, "/dotfiles");
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
        removeSkillName: "example",
      },
      {
        path: ".dotfiles/.agents/skills/Foo_Bar/SKILL.md",
        title: "Foo_Bar",
        exists: true,
        dirty: false,
      },
    ],
  });
  assert.equal(result.groups[0]?.files[0]?.dirty, true);
  const workflows = result.groups.find((group) => group.id === "workflows");
  assert.ok(workflows);
  assert.equal(workflows.files.find((file) => file.title === "Feature")?.dirty, true);
  assert.equal(workflows.files.find((file) => file.title === "Bug fix")?.exists, false);
  assert.ok(workflows.files.every((file) => file.removeSkillName === undefined));
  assert.equal(
    result.groups.flatMap((group) => group.files).find((file) => file.path === "mise.linux.toml")
      ?.exists,
    false,
  );
});

test("reads the machine the panel asked for", async () => {
  const ctx = createFakeContext({
    inspect: async (target) =>
      cleanRepo(target, {
        repoPath: target.hostId === "host_mac" ? "/Users/example/git/dotfiles" : "/dotfiles",
      }),
  });

  const result = await overview(ctx, { hostId: "host_mac" });

  assert.equal(result.state, "ready");
  assert.deepEqual(result.host, { id: "host_mac", name: "Local Mac" });
  assert.equal(result.state === "ready" && result.repoPath, "/Users/example/git/dotfiles");
});

test("names an offline machine instead of reading it", async () => {
  const ctx = createFakeContext({
    target: async () => ({ state: "offline", hostId: "host_mac", hostName: "Local Mac" }),
    inspect: async () => {
      throw new Error("must not reach an offline machine");
    },
  });

  assert.deepEqual(await overview(ctx, { hostId: "host_mac" }), {
    state: "offline",
    host: { id: "host_mac", name: "Local Mac" },
  });
});

test("names the path a missing repository was expected at", async () => {
  const ctx = createFakeContext({
    inspect: async (target) => ({ ...missingRepo(target), repoPath: "/nonexistent" }),
  });

  assert.deepEqual(await overview(ctx, {}), {
    state: "noRepository",
    host: { id: "host_server", name: "linux-builder" },
    repoPath: "/nonexistent",
  });
});
