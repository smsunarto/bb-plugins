import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandError } from "@bb-kit/core/command";

import { createFakeContext } from "../fake-context.ts";
import { check } from "./check.ts";

test("check throws when the repo is missing", async () => {
  await assert.rejects(
    () => Promise.resolve(check.execute(createFakeContext({ repoExists: () => false }), {})),
    (error: unknown) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.message, "dotfiles repo not found at /dotfiles");
      return true;
    },
  );
});

test("check without a target runs the full check task", async () => {
  const ctx = createFakeContext();
  const result = await check.execute(ctx, {});
  assert.deepEqual(result, { exitCode: 0, stdout: "ok" });
  assert.deepEqual(ctx.git.commands, ["mise run check"]);
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
    const ctx = createFakeContext();
    const result = await check.execute(ctx, { target });
    assert.deepEqual(result, { exitCode: 0, stdout: "ok" });
    assert.deepEqual(ctx.git.commands, [command]);
  }
});

test("check passes the task exit code and output through", async () => {
  const result = await check.execute(
    createFakeContext({
      run: async () => ({ exitCode: 3, output: "2 failures" }),
    }),
    { target: "mise" },
  );
  assert.deepEqual(result, { exitCode: 3, stdout: "2 failures" });
});

test("check with an unknown target throws", async () => {
  await assert.rejects(
    () => Promise.resolve(check.execute(createFakeContext(), { target: "nope" })),
    (error: unknown) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.exitCode, 2);
      assert.equal(error.message, "unknown check target: nope");
      return true;
    },
  );
});
