import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { type Link, MAX_LINKS, MAX_PINS, createStore } from "./store.ts";

function store() {
  const { bb } = createFakePluginHost({ pluginId: "code-review" });
  return { store: createStore(bb.storage.kv), kv: bb.storage.kv };
}

test("pins keep their order, ignore case, and stop at the limit", async () => {
  const { store: s } = store();
  await s.setPinned({ owner: "cli", repo: "cli", number: 1 }, true, "work");
  await s.setPinned({ owner: "acme", repo: "api", number: 2 }, true, "home");
  // Pinned once: pinned again as the same account it stays, as another it moves there.
  expect(await s.setPinned({ owner: "CLI", repo: "CLI", number: 1 }, true, "WORK")).toEqual([
    { owner: "cli", repo: "cli", number: 1, account: "work" },
    { owner: "acme", repo: "api", number: 2, account: "home" },
  ]);
  expect(await s.setPinned({ owner: "CLI", repo: "CLI", number: 1 }, true, "home")).toEqual([
    { owner: "cli", repo: "cli", number: 1, account: "home" },
    { owner: "acme", repo: "api", number: 2, account: "home" },
  ]);
  expect(await s.pins()).toEqual([
    { owner: "cli", repo: "cli", number: 1, account: "home" },
    { owner: "acme", repo: "api", number: 2, account: "home" },
  ]);
  expect(await s.setPinned({ owner: "Cli", repo: "cli", number: 1 }, false, "home")).toEqual([
    { owner: "acme", repo: "api", number: 2, account: "home" },
  ]);

  for (let n = 3; n <= MAX_PINS + 1; n++)
    await s.setPinned({ owner: "o", repo: "r", number: n }, true, "work");
  await expect(s.setPinned({ owner: "o", repo: "r", number: 999 }, true, "work")).rejects.toThrow(
    "You can pin up to 50 pull requests. Unpin one first.",
  );
});

test("instructions are trimmed, and blank clears them", async () => {
  const { store: s, kv } = store();
  expect(await s.setInstructions("  Focus on migrations.\n")).toBe("Focus on migrations.");
  expect(await s.instructions()).toBe("Focus on migrations.");
  expect(await s.setInstructions("   ")).toBe("");
  expect(await kv.list()).toEqual([]);
});

test("links are newest first per subject, shared across case, and the oldest are forgotten", async () => {
  const { store: s, kv } = store();
  for (let n = 1; n <= MAX_LINKS + 1; n++) {
    await s.addLink("Cli/CLI#7", {
      threadId: `t${n}`,
      kind: "review",
      createdAt: `${n}`,
      headRefOid: "abc",
      baseRefName: "main",
    });
  }
  await s.setRun({
    threadId: "t2",
    headRefOid: "abc",
    baseRefName: "main",
    reportedAt: "2026-10-09T00:00:00Z",
    summary: null,
    findings: [],
  });

  const links = await s.links("cli/cli#7");
  expect(links).toHaveLength(MAX_LINKS);
  expect(links[0]?.threadId).toBe("t21");
  expect(links.at(-1)?.threadId).toBe("t2");
  expect(await s.linkForThread("t1")).toBeNull();
  expect(await s.linkForThread("t21")).toEqual({
    key: "Cli/CLI#7",
    link: {
      threadId: "t21",
      kind: "review",
      createdAt: "21",
      headRefOid: "abc",
      baseRefName: "main",
    },
  });

  // One more pushes t2 out, with its run.
  await s.addLink("Cli/CLI#7", {
    threadId: "t22",
    kind: "fix",
    createdAt: "22",
    headRefOid: "def",
    baseRefName: "main",
  });
  expect(await s.run("t2")).toBeNull();
  expect((await kv.list("thread:")).toSorted()).not.toContain("thread:t2");
});

test("pins made at once both land", async () => {
  const { store: s } = store();
  const a = { owner: "cli", repo: "cli", number: 1 };
  const b = { owner: "acme", repo: "api", number: 2 };

  await Promise.all([s.setPinned(a, true, "work"), s.setPinned(b, true, "work")]);

  expect(await s.pins()).toEqual([
    { ...a, account: "work" },
    { ...b, account: "work" },
  ]);
});

test("threads linked at once are both remembered", async () => {
  const { store: s } = store();
  const key = "branch:0a1b2c3d4e5f";

  await Promise.all([
    s.addLink(key, {
      threadId: "t1",
      kind: "review",
      createdAt: "1",
      headRefOid: "abc",
      baseRefName: "main",
    }),
    s.addLink(key, {
      threadId: "t2",
      kind: "fix",
      createdAt: "2",
      headRefOid: "abc",
      baseRefName: "main",
    }),
  ]);

  expect((await s.links(key)).map((link) => link.threadId)).toEqual(["t2", "t1"]);
  expect((await s.linkForThread("t1"))?.key).toBe(key);
});

test("a record saved before a field existed is skipped, and the rest still read", async () => {
  const { store: s, kv } = store();
  const ref = { owner: "cli", repo: "cli", number: 7 };
  const current: Link = {
    threadId: "thr_new",
    kind: "review",
    createdAt: "2026-10-09T00:00:00Z",
    headRefOid: "abc",
    baseRefName: "main",
  };
  const { baseRefName: _, ...older } = { ...current, threadId: "thr_old" };
  await kv.set("links:cli/cli#7", [current, older]);
  await kv.set("run:thr_old", {
    threadId: "thr_old",
    headRefOid: "abc",
    reportedAt: "2026-10-09T00:00:00Z",
  });
  await kv.set("pins", [{ owner: "cli", repo: "cli", number: 7 }, { owner: "cli" }]);

  expect(await s.links("cli/cli#7")).toEqual([current]);
  expect(await s.run("thr_old")).toBeNull();
  expect(await s.pins()).toEqual([ref]);
});
