import { test } from "bun:test";
import assert from "node:assert/strict";
import { PluginCliError } from "@bb-kit/core/command";

import { createFakeContext } from "../fake-context.ts";
import { render } from "./render.ts";

const noArgs = { options: {}, positionals: {}, passthrough: [], help: "" };

test("render throws when the repo is missing", async () => {
  await assert.rejects(
    () => Promise.resolve(render.execute(createFakeContext({ repoExists: () => false }), noArgs)),
    (error: unknown) => {
      assert.ok(error instanceof PluginCliError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.message, "dotfiles repo not found at /dotfiles");
      return true;
    },
  );
});

test("render runs the render task and passes the result through", async () => {
  const ctx = createFakeContext({
    run: async () => ({ exitCode: 3, output: "rendered 2 files" }),
  });
  const result = await render.execute(ctx, noArgs);
  assert.deepEqual(result, { exitCode: 3, stdout: "rendered 2 files" });
  assert.deepEqual(
    ctx.git.run.mock.calls.map(([, command]) => command),
    ["mise run render"],
  );
});
