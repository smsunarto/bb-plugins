import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeCLI } from "@bb-kit/core/cli";
import { stubClient } from "@bb-kit/core/testing";
import type { Client } from "../server.ts";
import { sync } from "./sync.ts";

const okOverview: Client["overview"] = async () => ({
  repoPath: "/dotfiles",
  repoExists: true,
  branch: "main",
  groups: [],
  gitEntries: [],
});

test("sync exits 1 when the repo is missing", async () => {
  const client = stubClient<Client>({
    overview: async () => ({
      repoPath: "/dotfiles",
      repoExists: false,
      branch: "missing",
      groups: [],
      gitEntries: [],
    }),
  });
  const result = await invokeCLI({ sync }, client, ["sync"]);
  assert.deepEqual(result, { exitCode: 1, stderr: "dotfiles repo not found at /dotfiles\n" });
});

test("sync without --publish runs the pull-only task", async () => {
  const calls: string[] = [];
  const client = stubClient<Client>({
    overview: okOverview,
    publish: async () => {
      calls.push("publish");
      return { exitCode: 0, output: "published" };
    },
    runTask: async ({ task }) => {
      calls.push(task);
      return { exitCode: 0, output: "pulled" };
    },
  });
  const result = await invokeCLI({ sync }, client, ["sync"]);
  assert.deepEqual(result, { exitCode: 0, stdout: "pulled" });
  assert.deepEqual(calls, ["sync:pull"]);
});

test("sync --publish publishes instead of pulling", async () => {
  const calls: string[] = [];
  const client = stubClient<Client>({
    overview: okOverview,
    publish: async () => {
      calls.push("publish");
      return { exitCode: 1, output: "push rejected" };
    },
    runTask: async ({ task }) => {
      calls.push(task);
      return { exitCode: 0, output: "pulled" };
    },
  });
  const result = await invokeCLI({ sync }, client, ["sync", "--publish"]);
  assert.deepEqual(result, { exitCode: 1, stdout: "push rejected" });
  assert.deepEqual(calls, ["publish"]);
});
