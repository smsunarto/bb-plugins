import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeContext } from "../fake-context.ts";
import { check } from "./check.ts";

test("check exits 1 when the repo is missing", async () => {
  const result = await check.invoke(createFakeContext({ repoExists: () => false }));
  assert.deepEqual(result, { exitCode: 1, stderr: "dotfiles repo not found at /dotfiles\n" });
});

test("check without a target runs the full check task", async () => {
  const context = createFakeContext();
  const result = await check.invoke(context);
  assert.deepEqual(result, { exitCode: 0, stdout: "ok" });
  assert.deepEqual(context.git.commands, ["mise run check"]);
});

test("check routes each named target to its check task", async () => {
  const routes: Readonly<Record<string, string>> = {
    location: "mise run check:location",
    mise: "mise run check:mise",
    shell: "mise run check:shell",
    mcp: "mise run check:mcp",
    python: "mise run check:python",
    skills: "mise run check:skills",
    dotfiles: "mise run check:dotfiles",
    safety: "mise run check:safety",
    secrets: "mise run check:secrets",
  };
  for (const [target, command] of Object.entries(routes)) {
    const context = createFakeContext();
    const result = await check.invoke(context, [target]);
    assert.deepEqual(result, { exitCode: 0, stdout: "ok" });
    assert.deepEqual(context.git.commands, [command]);
  }
});

test("check passes the task exit code and output through", async () => {
  const result = await check.invoke(
    createFakeContext({
      run: async () => ({ exitCode: 3, output: "2 failures" }),
    }),
    ["mise"],
  );
  assert.deepEqual(result, { exitCode: 3, stdout: "2 failures" });
});

test("check with an unknown target exits 2", async () => {
  const result = await check.invoke(createFakeContext(), ["nope"]);
  assert.deepEqual(result, { exitCode: 2, stderr: "unknown check target: nope\n" });
});
