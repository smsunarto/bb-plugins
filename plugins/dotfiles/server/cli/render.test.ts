import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeContext } from "../fake-context.ts";
import { render } from "./render.ts";

test("render exits 1 when the repo is missing", async () => {
  const result = await render.invoke(createFakeContext({ repoExists: () => false }));
  assert.deepEqual(result, { exitCode: 1, stderr: "dotfiles repo not found at /dotfiles\n" });
});

test("render runs the render task and passes the result through", async () => {
  const commands: string[] = [];
  const result = await render.invoke(
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
