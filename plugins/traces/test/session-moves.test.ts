import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TraceIndex } from "../src/host/index.ts";
import { fixtureJsonl } from "./fixtures.ts";

for (const provider of ["codex", "claude-code"] as const) {
  test(`${provider}: moved sessions list their available copy and retain cached event access`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "bb-traces-move-"));
    const root = join(directory, "sessions");
    const archive = join(directory, "archive");
    await mkdir(root);
    await mkdir(archive);
    const path = join(root, "session.jsonl");
    const moved = join(archive, "session.jsonl");
    const contents = fixtureJsonl(provider);
    await writeFile(path, contents);
    const dataDir = join(directory, "index");
    const roots = [root, archive].map((path) => ({ provider, path, enabled: true }));
    let index = new TraceIndex({ dataDir, roots });
    context.after(async () => {
      await index.close();
      await rm(directory, { recursive: true, force: true });
    });
    await index.scan();
    const original = index.sessions({}).items[0]!;
    const cachedEvent = index.events({ sessionId: original.id }).items[0]!;

    // Copy then unlink also covers moves between filesystems (different inode).
    await copyFile(path, moved);
    await rm(path);
    await index.scan();
    const sessions = index.sessions({});
    assert.equal(sessions.items.length, 1);
    const current = sessions.items[0]!;
    assert.equal(current.path, moved);
    assert.equal(current.nativeId, original.nativeId);
    assert.equal(current.eventCount, original.eventCount);
    assert.equal(index.status().sessions, 1);
    assert.equal(index.status().events, current.eventCount);
    assert.equal(index.sessions({ nativeId: original.nativeId, limit: 1 }).nextCursor, null);
    assert.equal(index.sessions({ query: current.title }).items.length, 1);
    assert.equal((await index.event({ eventId: cachedEvent.id })).sourceState, "missing");
    const event = index.events({ sessionId: current.id }).items[0]!;
    assert.equal((await index.raw({ eventId: event.id })).state, "available");

    // The available copy may contain later records than the missing cache.
    await appendFile(moved, contents.split("\n").find(Boolean)! + "\n");
    await index.scan();
    assert.equal(index.sessions({}).items.length, 1);
    assert.ok(index.status().events > original.eventCount);
    await index.close();
    index = new TraceIndex({ dataDir, roots });
    assert.equal(index.sessions({}).items.length, 1);

    // Restoring the original location must make that copy visible again.
    await rename(moved, path);
    await index.scan();
    assert.deepEqual(
      index.sessions({}).items.map((item) => item.path),
      [path],
    );
  });
}

test("missing traces survive when a matching native ID has different or incomplete content", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bb-traces-distinct-"));
  const root = join(directory, "sessions");
  await mkdir(root);
  const originalPath = join(root, "original.jsonl");
  const replacementPath = join(root, "replacement.jsonl");
  const contents = fixtureJsonl("codex");
  await writeFile(originalPath, contents);
  const index = new TraceIndex({
    dataDir: join(directory, "index"),
    roots: [{ provider: "codex", path: root, enabled: true }],
  });
  context.after(async () => {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  });
  await index.scan();
  const original = index.sessions({}).items[0]!;
  await rm(originalPath);
  await index.scan();
  assert.equal(index.sessions({}).items[0]!.state, "missing");

  await writeFile(
    replacementPath,
    contents.replaceAll("Fix checkout validation", "Review checkout validation"),
  );
  await index.scan();
  assert.equal(index.sessions({ nativeId: original.nativeId }).items.length, 2);

  await writeFile(replacementPath, contents.split("\n").slice(0, 2).join("\n") + "\n");
  await index.scan();
  assert.equal(index.sessions({ nativeId: original.nativeId }).items.length, 2);
});
