import { test } from "bun:test";
import assert from "node:assert/strict";
import { createFakeContext } from "../fake-context.ts";
import { saveFile } from "./save-file.ts";

test("returns explicit save conflict and render outcomes", async () => {
  const conflict = createFakeContext({
    writeFile: async () => ({ outcome: "conflict" }),
  });
  assert.deepEqual(
    await saveFile(conflict, {
      path: ".dotfiles/mcp.json",
      content: "next",
      expectedSha256: "old",
    }),
    { outcome: "conflict" },
  );

  const written = createFakeContext();
  assert.deepEqual(
    await saveFile(written, {
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
    await saveFile(written, {
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
    await saveFile(ctx, {
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
      saveFile(ctx, {
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

  await saveFile(ctx, { hostId: "host_mac", path: "AGENTS.md", content: "next" });

  assert.deepEqual(writes, ["host_mac:/dotfiles/AGENTS.md = next"]);
});

test("workflow edits use the selected host and retain optimistic save conflicts", async () => {
  const path = ".dotfiles/.agents/plugins/scott-engineering/skills/dev/playbooks/feature.md";
  const ctx = createFakeContext({
    writeFile: async (repo, file, content, sha) => {
      assert.equal(repo.hostId, "host_mac");
      assert.equal(file, path);
      assert.equal(content, "updated workflow");
      assert.equal(sha, "before");
      return { outcome: "conflict" };
    },
  });
  assert.deepEqual(
    await saveFile(ctx, {
      hostId: "host_mac",
      path,
      content: "updated workflow",
      expectedSha256: "before",
    }),
    { outcome: "conflict" },
  );
  await assert.rejects(
    async () =>
      saveFile(ctx, {
        path: ".dotfiles/.agents/plugins/scott-engineering/skills/dev/playbooks/../../../../.ssh/id_ed25519",
        content: "x",
      }),
    /not a tweakable file/,
  );
});
