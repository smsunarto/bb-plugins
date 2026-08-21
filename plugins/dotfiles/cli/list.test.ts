import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeCLI } from "@bb-kit/core/cli";
import type { Client } from "../server.ts";
import { list } from "./list.ts";

function fakeClient(overrides: Partial<Client> = {}): Client {
  return {
    overview: async () => ({
      repoPath: "/dotfiles",
      repoExists: true,
      branch: "main",
      groups: [],
      gitEntries: [],
    }),
    publish: async () => ({ exitCode: 0, output: "published" }),
    readFile: async () => ({ content: "body", sha256: "sha", headContent: null }),
    removeSkill: async () => ({ outcome: "not-found" }),
    runTask: async () => ({ exitCode: 0, output: "ok" }),
    saveFile: async () => ({ outcome: "conflict" }),
    ...overrides,
  };
}

test("list exits 1 when the repo is missing", async () => {
  const client = fakeClient({
    overview: async () => ({
      repoPath: "/dotfiles",
      repoExists: false,
      branch: "missing",
      groups: [],
      gitEntries: [],
    }),
  });
  const result = await invokeCLI({ list }, client, ["list"]);
  assert.deepEqual(result, { exitCode: 1, stderr: "dotfiles repo not found at /dotfiles\n" });
});

test("list prints grouped files with bracketed flag suffixes", async () => {
  const client = fakeClient({
    overview: async () => ({
      repoPath: "/dotfiles",
      repoExists: true,
      branch: "main",
      groups: [
        {
          id: "agents",
          title: "Agent config",
          files: [
            {
              path: ".dotfiles/mcp.json",
              title: "MCP servers",
              render: true,
              exists: true,
              dirty: true,
            },
            { path: ".dotfiles/.gitconfig", title: ".gitconfig", exists: true, dirty: false },
            { path: "mise.linux.toml", title: "mise.linux.toml", exists: false, dirty: false },
          ],
        },
        {
          id: "overlays",
          title: "Settings overlays",
          files: [
            {
              path: ".dotfiles/.claude/settings.overlay.json",
              title: "Claude settings overlay",
              render: true,
              exists: true,
              dirty: false,
            },
            { path: "gone.toml", title: "gone", render: true, exists: false, dirty: true },
          ],
        },
      ],
      gitEntries: [],
    }),
  });
  const result = await invokeCLI({ list }, client, ["list"]);
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: [
      "# Agent config",
      "  .dotfiles/mcp.json  [dirty, renders]",
      "  .dotfiles/.gitconfig",
      "  mise.linux.toml  [MISSING]",
      "# Settings overlays",
      "  .dotfiles/.claude/settings.overlay.json  [renders]",
      "  gone.toml  [dirty, renders, MISSING]",
    ].join("\n"),
  });
});
