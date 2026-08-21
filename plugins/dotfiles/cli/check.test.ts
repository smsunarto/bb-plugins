import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeCLI } from "@bb-kit/core/cli";
import { stubClient } from "@bb-kit/core/testing";
import type { Client } from "../server.ts";
import { check } from "./check.ts";

const okOverview: Client["overview"] = async () => ({
  repoPath: "/dotfiles",
  repoExists: true,
  branch: "main",
  groups: [],
  gitEntries: [],
});

test("check exits 1 when the repo is missing", async () => {
  const client = stubClient<Client>({
    overview: async () => ({
      repoPath: "/dotfiles",
      repoExists: false,
      branch: "missing",
      groups: [],
      gitEntries: [],
    }),
  });
  const result = await invokeCLI({ check }, client, ["check"]);
  assert.deepEqual(result, { exitCode: 1, stderr: "dotfiles repo not found at /dotfiles\n" });
});

test("check without a target runs the full check task", async () => {
  const tasks: string[] = [];
  const client = stubClient<Client>({
    overview: okOverview,
    runTask: async ({ task }) => {
      tasks.push(task);
      return { exitCode: 0, output: "all green" };
    },
  });
  const result = await invokeCLI({ check }, client, ["check"]);
  assert.deepEqual(result, { exitCode: 0, stdout: "all green" });
  assert.deepEqual(tasks, ["check"]);
});

test("check routes each named target to its check task", async () => {
  const routes: Readonly<Record<string, string>> = {
    location: "check:location",
    mise: "check:mise",
    shell: "check:shell",
    mcp: "check:mcp",
    python: "check:python",
    skills: "check:skills",
    dotfiles: "check:dotfiles",
    safety: "check:safety",
    secrets: "check:secrets",
  };
  for (const [target, task] of Object.entries(routes)) {
    const tasks: string[] = [];
    const client = stubClient<Client>({
      overview: okOverview,
      runTask: async (input) => {
        tasks.push(input.task);
        return { exitCode: 0, output: "ok" };
      },
    });
    const result = await invokeCLI({ check }, client, ["check", target]);
    assert.deepEqual(result, { exitCode: 0, stdout: "ok" });
    assert.deepEqual(tasks, [task]);
  }
});

test("check passes the task exit code and output through", async () => {
  const client = stubClient<Client>({
    overview: okOverview,
    runTask: async () => ({ exitCode: 3, output: "2 failures" }),
  });
  const result = await invokeCLI({ check }, client, ["check", "mise"]);
  assert.deepEqual(result, { exitCode: 3, stdout: "2 failures" });
});

test("check with an unknown target exits 2", async () => {
  const client = stubClient<Client>({ overview: okOverview });
  const result = await invokeCLI({ check }, client, ["check", "nope"]);
  assert.deepEqual(result, { exitCode: 2, stderr: "unknown check target: nope\n" });
});
