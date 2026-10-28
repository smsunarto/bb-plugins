import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import { PluginCliError } from "@get-bb/plugin-sdk";

import { createFakeContext } from "../fake-context.ts";
import { cleanRepo } from "../fake-git.ts";
import type { DotfilesGit } from "../git.ts";
import { cat } from "./cat.ts";

function args(path: string) {
  return { options: {}, positionals: { path }, passthrough: [], help: "" };
}

test("cat throws when the repo is missing", async () => {
  await assert.rejects(
    () =>
      Promise.resolve(
        cat(
          createFakeContext({
            inspect: async (target) => cleanRepo(target, { repoExists: false }),
          }),
        ).run(args(".dotfiles/mcp.json"), {}),
      ),
    (error: unknown) => {
      assert.ok(error instanceof PluginCliError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.message, "dotfiles repo not found at /dotfiles on linux-builder");
      return true;
    },
  );
});

test("cat prints the file content", async () => {
  const readFile = mock<DotfilesGit["readFile"]>(async () => ({
    content: "alias ls=eza\n",
    sha256: "sha",
  }));
  const result = await cat(createFakeContext({ readFile })).run(args(".dotfiles/.gitconfig"), {});
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "alias ls=eza\n",
    stderr: "host: linux-builder · repo: /dotfiles\n",
  });
  assert.deepEqual(
    readFile.mock.calls.map(([repo, path]) => [repo.hostId, path]),
    [["host_server", ".dotfiles/.gitconfig"]],
  );
});

test("cat propagates a read error", async () => {
  await assert.rejects(
    () => Promise.resolve(cat(createFakeContext()).run(args(".ssh/id_ed25519"), {})),
    /not a tweakable file: \.ssh\/id_ed25519/,
  );
});
