import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "../server/context.ts";
import { createFakeRepository } from "../server/fake-repository.ts";
import { readFile } from "./read-file.ts";

test("reads only registered files", async () => {
  const context: Context = { repository: createFakeRepository(), log: () => {} };

  assert.deepEqual(await readFile.handler(context, { path: ".dotfiles/mcp.json" }), {
    content: "working",
    sha256: "sha-working",
    headContent: "head",
  });
  await assert.rejects(
    async () => readFile.handler(context, { path: ".ssh/id_ed25519" }),
    /not a tweakable file/,
  );
});
