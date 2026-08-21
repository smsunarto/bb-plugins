import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeCLI } from "@bb-kit/core/cli";
import { stubClient } from "@bb-kit/core/testing";
import type { Client } from "../server.ts";
import { render } from "./render.ts";

const okOverview: Client["overview"] = async () => ({
  repoPath: "/dotfiles",
  repoExists: true,
  branch: "main",
  groups: [],
  gitEntries: [],
});

test("render exits 1 when the repo is missing", async () => {
  const client = stubClient<Client>({
    overview: async () => ({
      repoPath: "/dotfiles",
      repoExists: false,
      branch: "missing",
      groups: [],
      gitEntries: [],
    }),
  });
  const result = await invokeCLI({ render }, client, ["render"]);
  assert.deepEqual(result, { exitCode: 1, stderr: "dotfiles repo not found at /dotfiles\n" });
});

test("render runs the render task and passes the result through", async () => {
  const tasks: string[] = [];
  const client = stubClient<Client>({
    overview: okOverview,
    runTask: async ({ task }) => {
      tasks.push(task);
      return { exitCode: 3, output: "rendered 2 files" };
    },
  });
  const result = await invokeCLI({ render }, client, ["render"]);
  assert.deepEqual(result, { exitCode: 3, stdout: "rendered 2 files" });
  assert.deepEqual(tasks, ["render"]);
});
