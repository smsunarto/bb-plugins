import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeContext } from "../fake-context.ts";
import { saveFile } from "./save-file.ts";

test("returns explicit save conflict and render outcomes", async () => {
  const conflict = createFakeContext({
    writeFile: async () => ({ outcome: "conflict" }),
  });
  assert.deepEqual(
    await saveFile.handler(conflict, {
      path: ".dotfiles/mcp.json",
      content: "next",
      expectedSha256: "old",
    }),
    { outcome: "conflict" },
  );

  const written = createFakeContext();
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
  const context = createFakeContext();

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
