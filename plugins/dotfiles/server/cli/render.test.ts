import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandError } from "@bb-kit/core/cli";

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
  const commands: string[] = [];
  const result = await render.execute(
    createFakeContext({
      run: async (_repoPath, command) => {
        commands.push(command);
        return { exitCode: 3, output: "rendered 2 files" };
      },
    }),
  );
  assert.deepEqual(result, { exitCode: 3, stdout: "rendered 2 files" });
  assert.deepEqual(commands, ["mise run render"]);
});
