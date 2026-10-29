import { test } from "bun:test";
import assert from "node:assert/strict";
import { PluginCliError } from "@get-bb/plugin-sdk";

import { createFakeContext } from "../fake-context.ts";
import { missingRepo } from "../fake-git.ts";
import { render } from "./render.ts";

const noArgs = { options: {}, positionals: {}, passthrough: [], help: "" };

test("render throws when the repo is missing", async () => {
  await assert.rejects(
    () =>
      Promise.resolve(
        render(
          createFakeContext({
            inspect: async (target) => missingRepo(target),
          }),
        ).run(noArgs, {}),
      ),
    (error: unknown) => {
      assert.ok(error instanceof PluginCliError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.message, "dotfiles repo not found at /dotfiles on linux-builder");
      return true;
    },
  );
});

test("render runs the render task and passes the result through", async () => {
  const ctx = createFakeContext({
    run: async () => ({ exitCode: 3, output: "rendered 2 files" }),
  });
  const result = await render(ctx).run(noArgs, {});
  assert.deepEqual(result, {
    exitCode: 3,
    stdout: "rendered 2 files",
    stderr: "host: linux-builder · repo: /dotfiles\n",
  });
  assert.deepEqual(
    ctx.git.run.mock.calls.map(([target, command]) => [target.hostId, command]),
    [["host_server", "mise run render"]],
  );
});
