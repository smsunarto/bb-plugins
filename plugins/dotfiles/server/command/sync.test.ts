import { test } from "bun:test";
import assert from "node:assert/strict";
import { CommandError } from "@bb-kit/core/command";

import { createFakeContext } from "../fake-context.ts";
import { sync } from "./sync.ts";

test("sync throws when the repo is missing", async () => {
  await assert.rejects(
    () =>
      Promise.resolve(
        sync.execute(createFakeContext({ repoExists: () => false }), { publish: false }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.message, "dotfiles repo not found at /dotfiles");
      return true;
    },
  );
});

test("sync without --publish runs the pull-only task", async () => {
  const ctx = createFakeContext({
    run: async () => ({ exitCode: 0, output: "pulled" }),
  });
  const result = await sync.execute(ctx, { publish: false });
  assert.deepEqual(result, { exitCode: 0, stdout: "pulled" });
  assert.deepEqual(
    ctx.git.run.mock.calls.map(([, command]) => command),
    ["mise run sync:pull"],
  );
});

test("sync --publish publishes instead of pulling", async () => {
  const ctx = createFakeContext({
    run: async () => ({ exitCode: 1, output: "push rejected" }),
  });
  const result = await sync.execute(ctx, { publish: true });
  assert.deepEqual(result, { exitCode: 1, stdout: "push rejected" });
  assert.deepEqual(
    ctx.git.run.mock.calls.map(([, command]) => command),
    ["mise run sync"],
  );
});
