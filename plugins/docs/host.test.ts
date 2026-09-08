import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "./host.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Docs host path listing", () => {
  it("keeps authored hidden trees and skips generated, dependency, metadata, and symlink trees", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-docs-host-"));
    temporaryDirectories.push(root);
    await Promise.all([
      mkdir(path.join(root, ".dotfiles", ".agents"), { recursive: true }),
      mkdir(path.join(root, ".agents"), { recursive: true }),
      mkdir(path.join(root, ".claude"), { recursive: true }),
      mkdir(path.join(root, ".claude", "worktrees", "checkout"), { recursive: true }),
      mkdir(path.join(root, ".git"), { recursive: true }),
      mkdir(path.join(root, "node_modules", "package"), { recursive: true }),
      mkdir(path.join(root, ".node_modules", "package"), { recursive: true }),
      mkdir(path.join(root, ".ruff_cache", "0.16.4"), { recursive: true }),
      mkdir(path.join(root, ".scratch"), { recursive: true }),
      mkdir(path.join(root, "dist"), { recursive: true }),
      mkdir(path.join(root, "outside"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, ".dotfiles", ".agents", "instructions.md"), "# Rules"),
      writeFile(path.join(root, ".agents", "AGENTS.md"), "# Agents"),
      writeFile(path.join(root, ".claude", "CLAUDE.md"), "# Claude"),
      writeFile(path.join(root, ".claude", "worktrees", "checkout", "AGENTS.md"), "# Generated"),
      writeFile(path.join(root, ".git", "config"), "[core]"),
      writeFile(path.join(root, "node_modules", "package", "README.md"), "# Package"),
      writeFile(path.join(root, ".node_modules", "package", "README.md"), "# Package"),
      writeFile(path.join(root, ".ruff_cache", "0.16.4", "README.md"), "# Cache"),
      writeFile(path.join(root, ".scratch", "notes.md"), "# Scratch"),
      writeFile(path.join(root, "dist", "README.md"), "# Build output"),
      writeFile(path.join(root, "outside", "linked.md"), "# Linked"),
    ]);
    await symlink(path.join(root, "outside"), path.join(root, "linked"));

    const host = experimental_createHostEntryHarness(hostEntry);
    const result = await host.experimental_call("listPaths", {
      path: root,
      includeFiles: true,
      includeDirectories: true,
      limit: 100,
    });
    await host.experimental_dispose();

    expect(result).toMatchObject({ truncated: false });
    expect(result.paths).toEqual(
      expect.arrayContaining([
        { kind: "directory", path: ".dotfiles" },
        { kind: "directory", path: ".dotfiles/.agents" },
        { kind: "file", path: ".dotfiles/.agents/instructions.md" },
        { kind: "directory", path: ".agents" },
        { kind: "file", path: ".agents/AGENTS.md" },
        { kind: "directory", path: ".claude" },
        { kind: "file", path: ".claude/CLAUDE.md" },
      ]),
    );
    for (const excludedPath of [
      ".claude/worktrees",
      ".git",
      ".node_modules",
      ".ruff_cache",
      ".scratch",
      "dist",
      "node_modules",
    ]) {
      expect(result.paths.some((entry) => entry.path.startsWith(excludedPath))).toBe(false);
    }
    expect(result.paths.some((entry) => entry.path.startsWith("linked"))).toBe(false);
  });
});
