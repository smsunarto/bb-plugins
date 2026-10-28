import { test } from "bun:test";
import assert from "node:assert/strict";
import { createFakeContext } from "../fake-context.ts";
import type { Repo } from "../git.ts";
import { readFile } from "./read-file.ts";

test("reads only registered files", async () => {
  const ctx = createFakeContext();

  assert.deepEqual(await readFile(ctx, { path: ".dotfiles/mcp.json" }), {
    content: "working",
    sha256: "sha-working",
    headContent: "head",
  });
  await assert.rejects(
    async () => readFile(ctx, { path: ".ssh/id_ed25519" }),
    /not a tweakable file/,
  );
});

test("reads the working file and its HEAD from the requested machine", async () => {
  const reads: string[] = [];
  const record = (kind: string) => async (repo: Repo, path: string) => {
    reads.push(`${kind} ${repo.hostId}:${repo.repoPath}/${path}`);
    return kind;
  };
  const ctx = createFakeContext({
    readFile: async (repo, path) => ({ content: await record("working")(repo, path), sha256: "s" }),
    readHeadFile: record("head"),
  });

  await readFile(ctx, { hostId: "host_mac", path: "AGENTS.md" });

  assert.deepEqual(reads.sort(), [
    "head host_mac:/dotfiles/AGENTS.md",
    "working host_mac:/dotfiles/AGENTS.md",
  ]);
});
