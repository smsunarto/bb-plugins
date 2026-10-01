import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import { PluginCliError } from "@bb-kit/core/command";

import { createFakeContext } from "../fake-context.ts";
import type { DotfilesGit } from "../git.ts";
import { cat } from "./cat.ts";

function args(path: string) {
  return { options: {}, positionals: { path }, passthrough: [], help: "" };
}

test("cat throws when the repo is missing", async () => {
  await assert.rejects(
    () =>
      Promise.resolve(
        cat.execute(createFakeContext({ repoExists: () => false }), args(".dotfiles/mcp.json")),
      ),
    (error: unknown) => {
      assert.ok(error instanceof PluginCliError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.message, "dotfiles repo not found at /dotfiles");
      return true;
    },
  );
});

test("cat prints the file content", async () => {
  const readFile = mock<DotfilesGit["readFile"]>(async () => ({
    content: "alias ls=eza\n",
    sha256: "sha",
  }));
  const result = await cat.execute(createFakeContext({ readFile }), args(".dotfiles/.gitconfig"));
  assert.deepEqual(result, { exitCode: 0, stdout: "alias ls=eza\n" });
  assert.deepEqual(
    readFile.mock.calls.map(([, path]) => path),
    [".dotfiles/.gitconfig"],
  );
});

test("cat propagates a read error", async () => {
  await assert.rejects(
    () => Promise.resolve(cat.execute(createFakeContext(), args(".ssh/id_ed25519"))),
    /not a tweakable file: \.ssh\/id_ed25519/,
  );
});
