import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeContext } from "../fake-context.ts";
import { cat } from "./cat.ts";

test("cat exits 1 when the repo is missing", async () => {
  const result = await cat.invoke(createFakeContext({ repoExists: () => false }), [
    ".dotfiles/mcp.json",
  ]);
  assert.deepEqual(result, { exitCode: 1, stderr: "dotfiles repo not found at /dotfiles\n" });
});

test("cat without a path exits 2 via commander", async () => {
  const result = await cat.invoke();
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? "", /missing required argument/);
});

test("cat prints the file content", async () => {
  const paths: string[] = [];
  const result = await cat.invoke(
    createFakeContext({
      readFile: async (_repoPath, path) => {
        paths.push(path);
        return { content: "alias ls=eza\n", sha256: "sha" };
      },
    }),
    [".dotfiles/.gitconfig"],
  );
  assert.deepEqual(result, { exitCode: 0, stdout: "alias ls=eza\n" });
  assert.deepEqual(paths, [".dotfiles/.gitconfig"]);
});

test("cat propagates a read error as exit 1", async () => {
  const result = await cat.invoke(createFakeContext(), [".ssh/id_ed25519"]);
  assert.deepEqual(result, { exitCode: 1, stderr: "not a tweakable file: .ssh/id_ed25519\n" });
});
