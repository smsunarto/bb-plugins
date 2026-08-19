import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TaskResult } from "../contract.js";
import { createDotfilesService, type DotfilesRepository } from "../service.js";

function repository(overrides: Partial<DotfilesRepository> = {}): DotfilesRepository {
  return {
    getRepoPath: async () => "/dotfiles",
    repoExists: () => true,
    pathExists: () => true,
    discoverSkills: () => [],
    gitStatus: async () => ({ branch: "main", entries: [] }),
    readFile: async () => ({ content: "working", sha256: "sha-working" }),
    readHeadFile: async () => "head",
    writeFile: async () => ({ outcome: "written", sha256: "sha-next" }),
    run: async () => ({ exitCode: 0, output: "ok" }),
    removeSkill: async () => ({ exitCode: 0, output: "removed" }),
    ...overrides,
  };
}

function service(overrides: Partial<DotfilesRepository> = {}) {
  return createDotfilesService({
    repository: repository(overrides),
    log: () => {},
  });
}

describe("dotfiles service", () => {
  test("builds the overview from static files, discovered skills, and git state", async () => {
    const result = await service({
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
    }).overview(null);

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
    const result = await service({
      repoExists: () => false,
      discoverSkills: () => {
        throw new Error("must not scan a missing repository");
      },
    }).overview(null);

    assert.equal(result.repoExists, false);
    assert.equal(result.branch, "missing");
    assert.deepEqual(result.gitEntries, []);
    assert.deepEqual(result.groups.at(-1)?.files, []);
  });

  test("reads only registered files", async () => {
    const dotfiles = service();
    assert.deepEqual(await dotfiles.readFile({ path: ".dotfiles/mcp.json" }), {
      content: "working",
      sha256: "sha-working",
      headContent: "head",
    });
    await assert.rejects(
      async () => dotfiles.readFile({ path: ".ssh/id_ed25519" }),
      /not a tweakable file/,
    );
  });

  test("returns explicit save conflict and render outcomes", async () => {
    const conflict = service({
      writeFile: async () => ({ outcome: "conflict" }),
    });
    assert.deepEqual(
      await conflict.saveFile({
        path: ".dotfiles/mcp.json",
        content: "next",
        expectedSha256: "old",
      }),
      { outcome: "conflict" },
    );

    const written = service();
    assert.deepEqual(
      await written.saveFile({
        path: ".dotfiles/mcp.json",
        content: "next",
        expectedSha256: "old",
      }),
      {
        outcome: "written",
        sha256: "sha-next",
        renderHint: true,
      },
    );
    assert.deepEqual(
      await written.saveFile({
        path: ".dotfiles/.gitconfig",
        content: "next",
        expectedSha256: "old",
      }),
      {
        outcome: "written",
        sha256: "sha-next",
        renderHint: false,
      },
    );
  });

  test("maps safe task ids and publishing to fixed commands", async () => {
    const commands: string[] = [];
    const result: TaskResult = { exitCode: 0, output: "done" };
    const dotfiles = service({
      run: async (_repoPath, command) => {
        commands.push(command);
        return result;
      },
    });

    assert.deepEqual(await dotfiles.runTask({ task: "check:skills" }), result);
    assert.deepEqual(await dotfiles.publish(null), result);
    assert.deepEqual(commands, ["mise run check:skills", "mise run sync"]);
  });

  test("makes stale skill removal an expected outcome", async () => {
    const missing = service();
    assert.deepEqual(await missing.removeSkill({ name: "example" }), {
      outcome: "not-found",
    });

    const existing = service({
      discoverSkills: () => [
        {
          path: ".dotfiles/.agents/skills/example/SKILL.md",
          title: "example",
        },
      ],
    });
    assert.deepEqual(await existing.removeSkill({ name: "example" }), {
      outcome: "completed",
      exitCode: 0,
      output: "removed",
    });
    await assert.rejects(
      async () => existing.removeSkill({ name: "../example" }),
      /invalid skill name/,
    );
  });
});
