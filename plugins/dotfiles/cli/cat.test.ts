import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeCLI } from "@bb-kit/core/cli";
import { stubClient } from "@bb-kit/core/testing";
import type { Client } from "../server.ts";
import { cat } from "./cat.ts";

const okOverview: Client["overview"] = async () => ({
  repoPath: "/dotfiles",
  repoExists: true,
  branch: "main",
  groups: [],
  gitEntries: [],
});

test("cat exits 1 when the repo is missing", async () => {
  const client = stubClient<Client>({
    overview: async () => ({
      repoPath: "/dotfiles",
      repoExists: false,
      branch: "missing",
      groups: [],
      gitEntries: [],
    }),
  });
  const result = await invokeCLI({ cat }, client, ["cat", ".dotfiles/mcp.json"]);
  assert.deepEqual(result, { exitCode: 1, stderr: "dotfiles repo not found at /dotfiles\n" });
});

test("cat without a path exits 2 via commander", async () => {
  const result = await invokeCLI({ cat }, stubClient<Client>({}), ["cat"]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? "", /missing required argument/);
});

test("cat prints the file content", async () => {
  const paths: string[] = [];
  const client = stubClient<Client>({
    overview: okOverview,
    readFile: async ({ path }) => {
      paths.push(path);
      return { content: "alias ls=eza\n", sha256: "sha", headContent: null };
    },
  });
  const result = await invokeCLI({ cat }, client, ["cat", ".dotfiles/.gitconfig"]);
  assert.deepEqual(result, { exitCode: 0, stdout: "alias ls=eza\n" });
  assert.deepEqual(paths, [".dotfiles/.gitconfig"]);
});

test("cat propagates a read error as exit 1", async () => {
  const client = stubClient<Client>({
    overview: okOverview,
    readFile: async () => {
      throw new Error("not a tweakable file: .ssh/id_ed25519");
    },
  });
  const result = await invokeCLI({ cat }, client, ["cat", ".ssh/id_ed25519"]);
  assert.deepEqual(result, { exitCode: 1, stderr: "not a tweakable file: .ssh/id_ed25519\n" });
});
