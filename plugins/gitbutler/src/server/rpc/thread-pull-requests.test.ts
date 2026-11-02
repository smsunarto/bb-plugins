import { expect, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HostPullRequestLookup } from "../../shared/pull-request.ts";
import { createThreadPullRequests } from "./thread-pull-requests.ts";

type Thread = { id: string; environmentId: string | null; parentId?: string; commands: string[] };

function view(branch: string, number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `PR for ${branch}`,
    state: "OPEN",
    url: `https://github.com/acme/app/pull/${number}`,
    isDraft: false,
    autoMerge: false,
    baseRefName: "main",
    headRefName: branch,
    headRefOid: "a".repeat(40),
    updatedAt: "2026-11-01T00:00:00Z",
    checks: [],
    reviewDecision: null,
    reviewRequestCount: 0,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    ...extra,
  };
}

/**
 * A bb with threads whose commands are their events, environments on one
 * host, and a host that knows pull requests by branch.
 */
function fakeBb(options: {
  threads: Thread[];
  pullRequests: Record<string, number>;
  /** Checkouts that are plain Git, not GitButler workspaces. */
  plain?: string[];
  fallback?: string | null;
  /** Holds every host read until released. */
  hold?: Promise<void>;
  /** Holds reads of one thread's events until released. */
  holdEvents?: { threadId: string; until: Promise<void> };
}) {
  const hostCalls: { method: string; input: Record<string, unknown> }[] = [];
  let eventReads = 0;
  const invalidated: string[] = [];
  const kv = new Map<string, unknown>();
  const threads = new Map(options.threads.map((thread) => [thread.id, thread]));
  const eventsOf = (thread: Thread) =>
    thread.commands.map((command, index) => ({
      seq: index + 1,
      createdAt: Date.parse("2026-11-01T00:00:00Z") + index * 1000 + thread.id.length,
      data: { item: { type: "commandExecution", command, exitCode: 0 } },
    }));
  const bb = {
    log: { debug() {}, warn() {} },
    storage: {
      kv: {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => void kv.set(key, value),
      },
    },
    rpc: { experimental_invalidate: (tags: readonly string[]) => invalidated.push(...tags) },
    sdk: {
      threads: {
        list: async ({ threadIds }: { threadIds: string[] }) =>
          threadIds.flatMap((id) => {
            const thread = threads.get(id);
            return thread ? [{ id, environmentId: thread.environmentId }] : [];
          }),
        events: {
          list: async ({
            threadId,
            afterSeq,
            beforeSeq,
            order,
            limit,
          }: {
            threadId: string;
            afterSeq?: string;
            beforeSeq?: string;
            order: "asc" | "desc";
            limit: string;
          }) => {
            eventReads += 1;
            if (options.holdEvents?.threadId === threadId) await options.holdEvents.until;
            // bb's own limit.
            if (Number(limit) > 100) throw new Error("Thread event limit cannot exceed 100");
            const events = eventsOf(threads.get(threadId)!).filter(
              (event) =>
                event.seq > Number(afterSeq ?? 0) && event.seq < Number(beforeSeq ?? Infinity),
            );
            return (order === "desc" ? events.reverse() : events).slice(0, Number(limit));
          },
        },
        experimental_listDescendants: async ({ threadIds }: { threadIds: string[] }) => ({
          threads: threadIds.map((id) => ({
            threadId: id,
            descendantIds: options.threads.filter((t) => t.parentId === id).map((t) => t.id),
          })),
        }),
        experimental_listAncestors: async ({ threadIds }: { threadIds: string[] }) => ({
          threads: threadIds.map((id) => {
            const ancestorIds: string[] = [];
            for (let at = threads.get(id)?.parentId; at; at = threads.get(at)?.parentId)
              ancestorIds.push(at);
            return { threadId: id, ancestorIds };
          }),
        }),
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({
          id: environmentId,
          hostId: "host-1",
          path: `/work/${environmentId}`,
          status: "ready",
        }),
      },
      hosts: { get: async () => ({ status: "connected", name: "Studio" }) },
    },
    hosts: {
      experimental_client: () => ({
        call: async (method: string, input: Record<string, unknown>) => {
          hostCalls.push({ method, input });
          await options.hold;
          if (method === "pullRequestAction")
            return { ok: true, number: options.pullRequests[input["branch"] as string] };
          if (options.plain?.includes(input["environmentPath"] as string))
            return { workspace: false };
          const lookups: Record<string, HostPullRequestLookup> = {};
          const fallbackBranch = input["fallback"] ? (options.fallback ?? null) : null;
          const wanted = [
            ...(input["branches"] as string[]),
            ...(fallbackBranch ? [fallbackBranch] : []),
          ];
          for (const branch of wanted) {
            const number = options.pullRequests[branch];
            lookups[branch] =
              number === undefined
                ? { outcome: "none" }
                : ({
                    outcome: "found",
                    pullRequest: view(branch, number),
                  } as HostPullRequestLookup);
          }
          return { workspace: true, fallbackBranch, lookups };
        },
      }),
    },
  } as unknown as BbPluginApi;
  return { bb, hostCalls, invalidated, threads, eventReads: () => eventReads };
}

const numberOf = (row: unknown) =>
  (row as { outcome: string; pullRequest?: { number: number } }).pullRequest?.number ?? null;

test("threads sharing a GitButler checkout each show their own branch's pull request", async () => {
  const { bb } = fakeBb({
    threads: [
      { id: "thr_a", environmentId: "env-1", commands: ['but commit -b scott/a -m "x"'] },
      { id: "thr_b", environmentId: "env-1", commands: ["but status", "but push scott/b"] },
      { id: "thr_none", environmentId: "env-1", commands: ["ls"] },
    ],
    pullRequests: { "scott/a": 11, "scott/b": 22 },
  });
  const rows = await createThreadPullRequests(bb).read(["thr_a", "thr_b", "thr_none"]);
  expect(numberOf(rows["thr_a"])).toBe(11);
  expect(numberOf(rows["thr_b"])).toBe(22);
  // Two applied branches have reviews, so there is no single one to fall back to.
  expect(rows["thr_none"]).toEqual({ outcome: "absent" });
});

test("a thread that named no branch shows the checkout's only reviewed branch", async () => {
  const { bb } = fakeBb({
    threads: [{ id: "thr_none", environmentId: "env-1", commands: ["ls"] }],
    pullRequests: { "scott/only": 33 },
    fallback: "scott/only",
  });
  const rows = await createThreadPullRequests(bb).read(["thr_none"]);
  expect(numberOf(rows["thr_none"])).toBe(33);
});

test("a thread that delegated its Git work takes its subthread's branch, and follows it", async () => {
  const fake = fakeBb({
    threads: [
      { id: "thr_parent", environmentId: "env-1", commands: ["bb thread spawn"] },
      {
        id: "thr_git",
        environmentId: "env-1",
        parentId: "thr_parent",
        commands: ["/bin/zsh -lc 'but commit -b scott/first -m x'"],
      },
    ],
    pullRequests: { "scott/first": 1, "scott/second": 2 },
  });
  const pullRequests = createThreadPullRequests(fake.bb);
  expect(numberOf((await pullRequests.read(["thr_parent"]))["thr_parent"])).toBe(1);

  // The subthread's next turn moves to another branch; the parent follows.
  fake.threads.get("thr_git")!.commands.push("but branch new scott/second");
  await pullRequests.turnEnded("thr_git", "env-1");
  expect(fake.invalidated).toContain("thread:thr_parent");
  expect(numberOf((await pullRequests.read(["thr_parent"]))["thr_parent"])).toBe(2);
});

test("a thread's own branch wins over a subthread's", async () => {
  const fake = fakeBb({
    threads: [
      { id: "thr_parent", environmentId: "env-1", commands: ["but push scott/mine"] },
      { id: "thr_child", environmentId: "env-1", parentId: "thr_parent", commands: [] },
    ],
    pullRequests: { "scott/mine": 5, "scott/theirs": 6 },
  });
  const pullRequests = createThreadPullRequests(fake.bb);
  expect(numberOf((await pullRequests.read(["thr_parent"]))["thr_parent"])).toBe(5);
  fake.threads.get("thr_child")!.commands.push("but push scott/theirs");
  await pullRequests.turnEnded("thr_child", "env-1");
  expect(numberOf((await pullRequests.read(["thr_parent"]))["thr_parent"])).toBe(5);
  expect(numberOf((await pullRequests.read(["thr_child"]))["thr_child"])).toBe(6);
});

test("outside a GitButler workspace rows are absent, and the checkout is asked once", async () => {
  const { bb, hostCalls } = fakeBb({
    threads: [
      { id: "thr_1", environmentId: "env-plain", commands: ["but push scott/x"] },
      { id: "thr_2", environmentId: "env-plain", commands: [] },
    ],
    pullRequests: { "scott/x": 9 },
    plain: ["/work/env-plain"],
  });
  const pullRequests = createThreadPullRequests(bb);
  expect(await pullRequests.read(["thr_1", "thr_2"])).toEqual({
    thr_1: { outcome: "absent" },
    thr_2: { outcome: "absent" },
  });
  await pullRequests.read(["thr_1", "thr_2"]);
  expect(hostCalls).toHaveLength(1);
});

test("a slow host answers absent within seconds, then tells watchers when it lands", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { bb, invalidated } = fakeBb({
    threads: [{ id: "thr_a", environmentId: "env-1", commands: ["but push scott/a"] }],
    pullRequests: { "scott/a": 7 },
    hold,
  });
  const pullRequests = createThreadPullRequests(bb);
  const started = Date.now();
  const rows = await pullRequests.read(["thr_a"]);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(numberOf(rows["thr_a"])).toBeNull();
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(invalidated).toContain("thread:thr_a");
  expect(numberOf((await pullRequests.read(["thr_a"]))["thr_a"])).toBe(7);
});

test("rechecking a thread keeps its row for other reads while GitHub answers", async () => {
  const options: Parameters<typeof fakeBb>[0] = {
    threads: [{ id: "thr_a", environmentId: "env-1", commands: ["but push scott/a"] }],
    pullRequests: { "scott/a": 7 },
  };
  const pullRequests = createThreadPullRequests(fakeBb(options).bb);
  expect(numberOf((await pullRequests.read(["thr_a"]))["thr_a"])).toBe(7);

  // Opening the thread rechecks it, and GitHub is slow to answer.
  let release!: () => void;
  options.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recheck = pullRequests.refresh("thr_a");
  const started = Date.now();
  expect(numberOf((await pullRequests.read(["thr_a"]))["thr_a"])).toBe(7);
  expect(Date.now() - started).toBeLessThan(1_000);
  release();
  await recheck;
});

test("a subthread working in another checkout lends its parent nothing", async () => {
  const { bb } = fakeBb({
    threads: [
      { id: "thr_parent", environmentId: "env-1", commands: [] },
      {
        id: "thr_elsewhere",
        environmentId: "env-other",
        parentId: "thr_parent",
        commands: ["but push scott/other-repo"],
      },
    ],
    pullRequests: { "scott/other-repo": 8 },
  });
  const rows = await createThreadPullRequests(bb).read(["thr_parent"]);
  expect(rows["thr_parent"]).toEqual({ outcome: "absent" });
});

test("outside a GitButler workspace no thread's history is read", async () => {
  const fake = fakeBb({
    threads: [{ id: "thr_1", environmentId: "env-plain", commands: ["but push scott/x"] }],
    pullRequests: { "scott/x": 9 },
    plain: ["/work/env-plain"],
  });
  await createThreadPullRequests(fake.bb).read(["thr_1"]);
  expect(fake.eventReads()).toBe(0);
});

test("an action names the pull request the reader saw", async () => {
  const fake = fakeBb({
    threads: [{ id: "thr_a", environmentId: "env-1", commands: ["but push scott/a"] }],
    pullRequests: { "scott/a": 7 },
  });
  const pullRequests = createThreadPullRequests(fake.bb);
  await pullRequests.read(["thr_a"]);
  const head = "b".repeat(40);
  const result = await pullRequests.act(
    "thr_a",
    { operation: "merge", method: "squash" },
    { url: "https://github.com/acme/app/pull/7", headRefOid: head },
  );
  expect(result.message).toBe("Merged pull request #7");
  expect(fake.hostCalls.find((call) => call.method === "pullRequestAction")?.input).toMatchObject({
    branch: "scott/a",
    expectedUrl: "https://github.com/acme/app/pull/7",
    expectedHeadOid: head,
  });
});

test("a branch one subthread named and another renamed shows under its new name", async () => {
  const { bb } = fakeBb({
    threads: [
      { id: "thr_parent", environmentId: "env-1", commands: ["bb thread spawn"] },
      {
        id: "thr_c1",
        environmentId: "env-1",
        parentId: "thr_parent",
        commands: ["but push scott/a"],
      },
      {
        id: "thr_c2",
        environmentId: "env-1",
        parentId: "thr_parent",
        commands: ["ls", "but reword scott/a -m scott/b"],
      },
    ],
    pullRequests: { "scott/a": 1, "scott/b": 2 },
  });
  const rows = await createThreadPullRequests(bb).read(["thr_parent"]);
  expect(numberOf(rows["thr_parent"])).toBe(2);
});

test("a thread moved to another checkout reads its branch there afresh", async () => {
  const fake = fakeBb({
    threads: [
      {
        id: "thr_a",
        environmentId: "env-1",
        commands: ["cd /work/env-1 && but push scott/a"],
      },
    ],
    pullRequests: { "scott/a": 7 },
  });
  const pullRequests = createThreadPullRequests(fake.bb);
  expect(numberOf((await pullRequests.read(["thr_a"]))["thr_a"])).toBe(7);
  // Its commands ran in env-1's checkout, so in env-2 they name nothing.
  fake.threads.get("thr_a")!.environmentId = "env-2";
  expect((await pullRequests.read(["thr_a"]))["thr_a"]).toEqual({ outcome: "absent" });
});

test("a recheck that started before a subthread's turn ended cannot restore the old branch", async () => {
  let release!: () => void;
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeBb({
    threads: [
      { id: "thr_parent", environmentId: "env-1", commands: ["bb thread spawn"] },
      {
        id: "thr_git",
        environmentId: "env-1",
        parentId: "thr_parent",
        commands: ["but push scott/first"],
      },
      { id: "thr_slow", environmentId: "env-1", parentId: "thr_parent", commands: ["ls"] },
    ],
    pullRequests: { "scott/first": 1, "scott/second": 2 },
    holdEvents: { threadId: "thr_slow", until },
  });
  const pullRequests = createThreadPullRequests(fake.bb);
  // The parent's read has thr_git's first branch and waits on thr_slow
  // while thr_git's next turn ends.
  const early = pullRequests.read(["thr_parent"]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  fake.threads.get("thr_git")!.commands.push("but push scott/second");
  await pullRequests.turnEnded("thr_git", "env-1");
  // A read while the old resolve still runs gets the new branch, not the old one.
  const during = pullRequests.read(["thr_parent"]);
  release();
  // Both the read that started first and the one that came after see the new branch.
  expect(numberOf((await early)["thr_parent"])).toBe(2);
  expect(numberOf((await during)["thr_parent"])).toBe(2);
  expect(numberOf((await pullRequests.read(["thr_parent"]))["thr_parent"])).toBe(2);
});

test("reads of one checkout that arrive together ask its host once", async () => {
  let release!: () => void;
  const options: Parameters<typeof fakeBb>[0] = {
    threads: [{ id: "thr_a", environmentId: "env-1", commands: ["but push scott/a"] }],
    pullRequests: { "scott/a": 7 },
  };
  const fake = fakeBb(options);
  const pullRequests = createThreadPullRequests(fake.bb);
  await pullRequests.read(["thr_a"]);
  const before = fake.hostCalls.length;
  options.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads = [pullRequests.refresh("thr_a"), pullRequests.refresh("thr_a")];
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await Promise.all(reads);
  // The second waits for the first, then finds its answer fresh.
  expect(fake.hostCalls.length - before).toBe(1);
});

test("a long stretch of new events is read over several passes", async () => {
  const fake = fakeBb({
    threads: [{ id: "thr_a", environmentId: "env-1", commands: ["but push scott/a"] }],
    pullRequests: { "scott/a": 1, "scott/z": 26 },
  });
  const pullRequests = createThreadPullRequests(fake.bb);
  expect(numberOf((await pullRequests.read(["thr_a"]))["thr_a"])).toBe(1);
  const commands = fake.threads.get("thr_a")!.commands;
  commands.push(...Array.from({ length: 5_050 }, () => "ls"), "but push scott/z");
  // One pass stops short of the newest events; the next carries on by itself
  // and tells watchers when the branch moves.
  await pullRequests.turnEnded("thr_a", "env-1");
  fake.invalidated.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(fake.invalidated).toContain("thread:thr_a");
  expect(numberOf((await pullRequests.read(["thr_a"]))["thr_a"])).toBe(26);
});
