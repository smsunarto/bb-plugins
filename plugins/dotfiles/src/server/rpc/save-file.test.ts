import { test } from "bun:test";
import assert from "node:assert/strict";
import { createFakeContext } from "../fake-context.ts";
import { saveFile } from "./save-file.ts";

test("returns explicit save conflict and render outcomes", async () => {
  const conflict = createFakeContext({
    writeFile: async () => ({ outcome: "conflict" }),
  });
  assert.deepEqual(
    await saveFile.execute(conflict, {
      path: ".dotfiles/mcp.json",
      content: "next",
      expectedSha256: "old",
    }),
    { outcome: "conflict" },
  );

  const written = createFakeContext();
  assert.deepEqual(
    await saveFile.execute(written, {
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
    await saveFile.execute(written, {
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

test("omitting expectedSha256 writes unconditionally", async () => {
  let captured: string | undefined = "unset";
  const ctx = createFakeContext({
    writeFile: async (_repo, _path, _content, expectedSha256) => {
      captured = expectedSha256;
      return { outcome: "written", sha256: "sha-forced" };
    },
  });

  assert.deepEqual(
    await saveFile.execute(ctx, {
      path: ".dotfiles/mcp.json",
      content: "next",
    }),
    {
      outcome: "written",
      sha256: "sha-forced",
      renderHint: true,
    },
  );
  assert.equal(captured, undefined);
});

test("saves only registered files", async () => {
  const ctx = createFakeContext();

  await assert.rejects(
    async () =>
      saveFile.execute(ctx, {
        path: ".ssh/id_ed25519",
        content: "next",
        expectedSha256: "old",
      }),
    /not a tweakable file/,
  );
});

test("writes to the machine the draft was read from", async () => {
  const writes: string[] = [];
  const ctx = createFakeContext({
    writeFile: async (repo, path, content) => {
      writes.push(`${repo.hostId}:${repo.repoPath}/${path} = ${content}`);
      return { outcome: "written", sha256: "sha-mac" };
    },
  });

  await saveFile.execute(ctx, { hostId: "host_mac", path: "AGENTS.md", content: "next" });

  assert.deepEqual(writes, ["host_mac:/dotfiles/AGENTS.md = next"]);
});
