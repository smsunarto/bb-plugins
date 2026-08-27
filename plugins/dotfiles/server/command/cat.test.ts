import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandError } from "@bb-kit/core/command";

import { createFakeContext } from "../fake-context.ts";
import { cat } from "./cat.ts";

test("cat throws when the repo is missing", async () => {
  await assert.rejects(
    () => Promise.resolve(cat.execute(createFakeContext({ repoExists: () => false }), { path: ".dotfiles/mcp.json" })),
    (error: unknown) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.message, "dotfiles repo not found at /dotfiles");
      return true;
    },
  );
});

test("cat prints the file content", async () => {
  const paths: string[] = [];
  const result = await cat.execute(
    createFakeContext({
      readFile: async (_repoPath, path) => {
        paths.push(path);
        return { content: "alias ls=eza\n", sha256: "sha" };
      },
    }),
    { path: ".dotfiles/.gitconfig" },
  );
  assert.deepEqual(result, { exitCode: 0, stdout: "alias ls=eza\n" });
  assert.deepEqual(paths, [".dotfiles/.gitconfig"]);
});

test("cat propagates a read error", async () => {
  await assert.rejects(
    () => Promise.resolve(cat.execute(createFakeContext(), { path: ".ssh/id_ed25519" })),
    /not a tweakable file: \.ssh\/id_ed25519/,
  );
});
