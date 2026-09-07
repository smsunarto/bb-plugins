import { test } from "bun:test";
import assert from "node:assert/strict";
import { CommandError } from "@bb-kit/core/command";

import { createFakeContext } from "../fake-context.ts";
import { render } from "./render.ts";

test("render throws when the repo is missing", async () => {
  await assert.rejects(
    () => Promise.resolve(render.execute(createFakeContext({ repoExists: () => false }))),
    (error: unknown) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.message, "dotfiles repo not found at /dotfiles");
      return true;
    },
  );
});

test("render runs the render task and passes the result through", async () => {
  const ctx = createFakeContext({
    run: async () => ({ exitCode: 3, output: "rendered 2 files" }),
  });
  const result = await render.execute(ctx);
  assert.deepEqual(result, { exitCode: 3, stdout: "rendered 2 files" });
  assert.deepEqual(
    ctx.git.run.mock.calls.map(([, command]) => command),
    ["mise run render"],
  );
});
