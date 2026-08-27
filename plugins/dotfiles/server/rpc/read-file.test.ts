import { test } from "bun:test";
import assert from "node:assert/strict";
import { createFakeContext } from "../fake-context.ts";
import { readFile } from "./read-file.ts";

test("reads only registered files", async () => {
  const ctx = createFakeContext();

  assert.deepEqual(await readFile.execute(ctx, { path: ".dotfiles/mcp.json" }), {
    content: "working",
    sha256: "sha-working",
    headContent: "head",
  });
  await assert.rejects(
    async () => readFile.execute(ctx, { path: ".ssh/id_ed25519" }),
    /not a tweakable file/,
  );
});
