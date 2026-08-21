import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "../server/context.ts";
import { createFakeRepository } from "../server/fake-repository.ts";
import { saveFile } from "./save-file.ts";

test("returns explicit save conflict and render outcomes", async () => {
  const conflict: Context = {
    repository: createFakeRepository({
      writeFile: async () => ({ outcome: "conflict" }),
    }),
    log: () => {},
  };
  assert.deepEqual(
    await saveFile.handler(conflict, {
      path: ".dotfiles/mcp.json",
      content: "next",
      expectedSha256: "old",
    }),
    { outcome: "conflict" },
  );

  const written: Context = { repository: createFakeRepository(), log: () => {} };
  assert.deepEqual(
    await saveFile.handler(written, {
      path: ".dotfiles/mcp.json",
      content: "next",
      expectedSha256: "old",
    }),
    {
      outcome: "written",
      sha256: "sha-next",
      renderHint: true,
    },
  );
  assert.deepEqual(
    await saveFile.handler(written, {
      path: ".dotfiles/.gitconfig",
      content: "next",
      expectedSha256: "old",
    }),
    {
      outcome: "written",
      sha256: "sha-next",
      renderHint: false,
    },
  );
});

test("saves only registered files", async () => {
  const context: Context = { repository: createFakeRepository(), log: () => {} };

  await assert.rejects(
    async () =>
      saveFile.handler(context, {
        path: ".ssh/id_ed25519",
        content: "next",
        expectedSha256: "old",
      }),
    /not a tweakable file/,
  );
});
