import { expect, onTestFinished, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Effect } from "effect";
import {
  changeKeyForBranch,
  type Branch,
  type PullRequest,
  type WorkspaceValue,
} from "../core/change.ts";
import { changeKeySchema } from "../core/ids.ts";
import type { ForgeSites } from "./forge-sites.ts";
import type { LocalReads } from "./local-read.ts";
import { localMatch } from "./review-change.ts";
import { createReviewSources } from "./review-sources.ts";
import { openStore } from "./store.ts";

function branch(name: string, head = "aaa1111"): Branch {
  return {
    name,
    head,
    remote: null,
    status: "unpushed",
    push: "none",
    ahead: 1,
    behind: 0,
    newUpstream: 0,
    reviewId: null,
    commits: [
      {
        id: head,
        subject: `work on ${name}`,
        createdAt: "2026-01-01T00:00:00Z",
        conflicted: false,
      },
    ],
    moreCommits: 0,
    upstreamCommits: [],
  };
}

function workspace(path: string, branchNames: string[]): WorkspaceValue {
  return {
    provider: "git",
    path,
    commonDir: `${path}/.git`,
    github: { repo: { owner: "smsunarto", name: "bb-plugins" }, headOwner: "smsunarto" },
    target: { ref: "origin/main", head: "0000000", behind: 0, base: null, lastFetched: null },
    checkedOut: branchNames[0] ?? null,
    uncommitted: [],
    moreUncommitted: 0,
    conflicted: [],
    stacks: branchNames.map((name) => ({
      key: name,
      branches: [branch(name)],
      assigned: [],
    })),
  };
}

function pr(number: number): PullRequest {
  return {
    number,
    url: `https://github.com/smsunarto/bb-plugins/pull/${number}`,
    title: `PR #${number}`,
    state: "open",
    isDraft: false,
    headRefOid: "aaa1111",
    baseRef: "main",
    reviewDecision: null,
    approvals: 0,
    mergeable: "mergeable",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    commits: 1,
    checks: { passed: 1, failed: 0, pending: 0 },
  };
}

function openInstrumentedStore() {
  const { bb, harness } = createFakePluginHost({ pluginId: "source-control" });
  onTestFinished(() => harness.lifecycle.dispose());
  const db = bb.storage.database();
  const counts: Record<string, number> = {};
  const bump = (sql: string) => {
    const match = /\bFROM\s+(\w+)/i.exec(sql);
    const table = match?.[1] ?? "other";
    counts[table] = (counts[table] ?? 0) + 1;
  };
  const origPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    const stmt = origPrepare(sql);
    const origGet = stmt.get.bind(stmt);
    const origAll = stmt.all.bind(stmt);
    return Object.assign(stmt, {
      get(...args: unknown[]) {
        bump(sql);
        return origGet(...args);
      },
      all(...args: unknown[]) {
        bump(sql);
        return origAll(...args);
      },
    });
  }) as typeof db.prepare;
  const instrumentedBb = {
    ...bb,
    storage: {
      ...bb.storage,
      database: () => db,
    },
  };
  const store = openStore(instrumentedBb);
  const resetCounts = () => {
    for (const k of Object.keys(counts)) delete counts[k];
  };
  return { store, counts, resetCounts };
}

test("store caches placement, local, forge, checks and checkouts and invalidates on writes and forgetHost", () => {
  const { store, counts, resetCounts } = openInstrumentedStore();
  const placement = {
    state: "checkout" as const,
    placement: { hostId: "host-a", hostName: "mac", path: "/repo", environmentId: "env-a" },
  };
  const ws = workspace("/repo", ["feat/a"]);
  const key = changeKeyForBranch("host-a", ws, ws.stacks[0]!.branches[0]!);

  store.setPlacement("thr-1", placement, 100);
  store.setLocal("host-a", "/repo", { read: { value: ws, at: 100 }, problem: null });
  store.setForgeFacets(key, {
    forge: { read: { value: pr(10), at: 100 }, problem: null },
    checks: { read: { value: { head: "aaa1111", rows: [], more: false }, at: 100 }, problem: null },
    threads: { read: { value: [], at: 100 }, problem: null },
  });

  // Prime caches.
  expect(store.placement("thr-1")).toEqual(placement);
  expect(store.local("host-a", "/repo").read?.value.path).toBe("/repo");
  expect(store.forge(key).read?.value?.number).toBe(10);
  expect(store.checks(key).read?.value?.head).toBe("aaa1111");
  expect(store.checkouts()).toHaveLength(1);
  resetCounts();

  // Warm reads hit memory with zero SQLite queries.
  for (let i = 0; i < 5; i += 1) {
    expect(store.placement("thr-1")).toEqual(placement);
    expect(store.local("host-a", "/repo").read?.value.path).toBe("/repo");
    expect(store.forge(key).read?.value?.number).toBe(10);
    expect(store.checks(key).read?.value?.head).toBe("aaa1111");
    expect(store.checkouts()).toHaveLength(1);
  }
  expect(counts).toEqual({});

  // Updates invalidate cached entries cleanly.
  const ws2 = workspace("/repo", ["feat/b"]);
  store.setLocal("host-a", "/repo", { read: { value: ws2, at: 200 }, problem: null });
  expect(store.local("host-a", "/repo").read?.value.checkedOut).toBe("feat/b");

  store.setForge(key, { read: { value: pr(11), at: 200 }, problem: null });
  expect(store.forge(key).read?.value?.number).toBe(11);

  store.setForgeFacets(key, {
    forge: { read: { value: pr(12), at: 300 }, problem: null },
    checks: { read: { value: { head: "bbb2222", rows: [], more: false }, at: 300 }, problem: null },
    threads: { read: { value: [], at: 300 }, problem: null },
  });
  expect(store.forge(key).read?.value?.number).toBe(12);
  expect(store.checks(key).read?.value?.head).toBe("bbb2222");

  // forgetHost drops placement, local and checkout caches.
  store.forgetHost("host-a", 400);
  expect(store.placement("thr-1")?.state).toBe("none");
  expect(store.local("host-a", "/repo").read).toBeNull();
  expect(store.checkouts()).toEqual([]);
});

test("reverse ChangeKey index avoids scanning unrelated checkouts and eliminates double local() reads", () => {
  const { store, counts, resetCounts } = openInstrumentedStore();
  for (let i = 0; i < 20; i += 1) {
    const path = `/repo-${i}`;
    store.setPlacement(
      `thr-${i}`,
      {
        state: "checkout",
        placement: { hostId: "host-a", hostName: "mac", path, environmentId: `env-${i}` },
      },
      100,
    );
    store.setLocal("host-a", path, {
      read: { value: workspace(path, [`branch-${i}`]), at: 100 },
      problem: null,
    });
  }

  const targetKey = changeKeySchema.parse("gh:smsunarto/bb-plugins:smsunarto:branch-7");
  const missingKey = changeKeySchema.parse("gh:smsunarto/bb-plugins:smsunarto:does-not-exist");

  // First lookup builds the reverse index once.
  const first = localMatch(store, targetKey);
  expect(first?.placement.path).toBe("/repo-7");
  resetCounts();

  // Subsequent hit and miss touch zero SQLite rows and call store.local() at most once (0 on miss).
  const localSpy = vi.spyOn(store, "local");
  const hit = localMatch(store, targetKey);
  expect(hit?.placement.path).toBe("/repo-7");
  expect(localSpy).toHaveBeenCalledTimes(1);
  expect(counts).toEqual({});

  localSpy.mockClear();
  expect(localMatch(store, missingKey)).toBeNull();
  expect(localSpy).not.toHaveBeenCalled();
  expect(counts).toEqual({});

  // hostChanges also calls store.local() once per checkout, never twice.
  localSpy.mockClear();
  const sources = createReviewSources({
    store,
    sites: {} as ForgeSites,
    local: {} as LocalReads,
    share: (_k, work) => work,
    invalidate: () => {},
    now: () => 200,
    knownHosts: Effect.succeed(["host-a"]),
  });
  const rows = sources.hostChanges(["host-a"])["host-a"];
  expect(rows?.read?.rows).toHaveLength(20);
  expect(localSpy).toHaveBeenCalledTimes(20);

  // Updating local branches or removing the checkout updates the reverse index.
  store.setLocal("host-a", "/repo-7", {
    read: { value: workspace("/repo-7", ["branch-7-renamed"]), at: 300 },
    problem: null,
  });
  expect(localMatch(store, targetKey)).toBeNull();
  expect(
    localMatch(store, changeKeySchema.parse("gh:smsunarto/bb-plugins:smsunarto:branch-7-renamed"))
      ?.placement.path,
  ).toBe("/repo-7");

  store.forgetHost("host-a", 400);
  expect(
    localMatch(store, changeKeySchema.parse("gh:smsunarto/bb-plugins:smsunarto:branch-7-renamed")),
  ).toBeNull();
});
