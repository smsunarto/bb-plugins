import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeCLI } from "@bb-kit/core/cli";
import type { Client } from "../server.ts";
import { status } from "./status.ts";

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

test("status exits 1 when the repo is missing", async () => {
  const client = fakeClient({
    overview: async () => ({
      repoPath: "/dotfiles",
      repoExists: false,
      branch: "missing",
      groups: [],
      gitEntries: [],
    }),
  });
  const result = await invokeCLI({ status }, client, ["status"]);
  assert.deepEqual(result, { exitCode: 1, stderr: "dotfiles repo not found at /dotfiles\n" });
});

test("status prints the branch and two-column entries", async () => {
  const client = fakeClient({
    overview: async () => ({
      repoPath: "/dotfiles",
      repoExists: true,
      branch: "feature",
      groups: [],
      gitEntries: [
        { status: "M", path: ".dotfiles/mcp.json" },
        { status: "??", path: ".dotfiles/new.txt" },
      ],
    }),
  });
  const result = await invokeCLI({ status }, client, ["status"]);
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "branch: feature\nM  .dotfiles/mcp.json\n?? .dotfiles/new.txt",
  });
});

test("status prints clean when there are no entries", async () => {
  const result = await invokeCLI({ status }, fakeClient(), ["status"]);
  assert.deepEqual(result, { exitCode: 0, stdout: "branch: main\nclean" });
});
