import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type {
  Branch,
  PullRequest,
  ThreadChange,
  VcsResult,
  WorkspaceValue,
} from "../core/change.ts";
import type { Exec } from "../forge/github.ts";
import { createSourceControl } from "./server.ts";

const PLUGIN = "source-control";

function branch(overrides: Partial<Branch> = {}): Branch {
  return {
    name: "scott/route-gh",
    head: "c0ffee",
    remote: { ref: "origin/scott/route-gh", name: "scott/route-gh" },
    status: "pushed",
    push: "none",
    ahead: 0,
    behind: 0,
    newUpstream: 0,
    reviewId: null,
    commits: [
      {
        id: "c0ffee",
        subject: "Route gh through the checkout host",
        createdAt: null,
        conflicted: false,
      },
    ],
    moreCommits: 0,
    upstreamCommits: [],
    ...overrides,
  };
}

function workspace(path: string, overrides: Partial<WorkspaceValue> = {}): WorkspaceValue {
  const only = branch();
  return {
    provider: "git",
    path,
    commonDir: `${path}/.git`,
    checkedOut: only.name,
    github: { repo: { owner: "smsunarto", name: "bb-plugins" }, headOwner: "smsunarto" },
    uncommitted: [{ path: "src/a.ts", kind: "modified" }],
    moreUncommitted: 0,
    conflicted: [],
    stacks: [{ key: only.name, branches: [only], assigned: [] }],
    target: { ref: "origin/main", head: "aaa111", behind: 0, base: null, lastFetched: null },
    ...overrides,
  };
}

const PR = {
  number: 482,
  url: "https://github.com/smsunarto/bb-plugins/pull/482",
  title: "Route gh through the checkout host",
  state: "OPEN",
  isDraft: true,
  headRefOid: "c0ffee",
  baseRefName: "main",
  reviewDecision: null,
  headRepositoryOwner: { login: "smsunarto" },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
            },
          },
        },
      },
    ],
  },
};

type Host = {
  name: string;
  online: boolean;
  /** Never answers while true, as a host that stopped responding. */
  hung?: boolean;
  /** Answers each workspace read after this long, by the fake clock. */
  delayMs?: number;
  workspace: WorkspaceValue;
  ghAccounts: string[];
  action?: VcsResult;
};

type World = {
  hosts: Record<string, Host>;
  threads: Record<string, { hostId: string; path: string; environmentId?: string }>;
  serverAccounts: string[];
  /** Pull requests by the head branch name GitHub was asked about. */
  pullRequests: Record<string, unknown[]>;
  ghCalls: string[];
  /** When each `gh` run on the server started, by the fake clock. */
  ghRuns?: number[];
  /** Server accounts GitHub answers "not found" for this repository. */
  cannotSee?: string[];
  /** The account each pull request read on the server ran as. */
  readAs?: string[];
  /** Each `gh pr ready` on the server, with the account it ran as. */
  writes?: { login: string; args: readonly string[] }[];
  /** Inbox searches, by the account they ran as, and what GitHub answers. */
  inboxReads?: string[];
  inbox?: { mine: unknown[]; asked: unknown[] };
  /** REST reads (`gh api <path>`) and their pages. */
  rest?: Record<string, unknown[][]>;
  restReads?: string[];
  /** Host workspace reads in flight now, and the most at once. */
  inFlight?: number;
  maxInFlight?: number;
};

type Run = Awaited<ReturnType<Exec>>;

/** `gh auth token` and `gh auth status` for the world's server accounts. */
function fakeAuth(world: World, args: readonly string[]): Run {
  if (args[1] === "token") {
    const login = args[args.indexOf("--user") + 1]!;
    return world.serverAccounts.includes(login)
      ? { code: 0, stdout: `tok-${login}\n`, stderr: "" }
      : { code: 1, stdout: "", stderr: `no account found for ${login}` };
  }
  if (world.serverAccounts.length === 0)
    return {
      code: 1,
      stdout: "",
      stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login",
    };
  return {
    code: 0,
    stdout: world.serverAccounts
      .map(
        (login, index) =>
          `github.com\n  ✓ Logged in to github.com account ${login} (keyring)\n  - Active account: ${index === 0}`,
      )
      .join("\n"),
    stderr: "",
  };
}

/** `gh api --paginate --slurp <path>`: the world's pages for the path. */
function fakeRest(world: World, args: readonly string[]): Run {
  const path = args.at(-1)!;
  (world.restReads ??= []).push(path);
  const pages = world.rest?.[path];
  return pages
    ? { code: 0, stdout: JSON.stringify(pages), stderr: "" }
    : { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
}

function fakeInbox(world: World, login: string): Run {
  (world.inboxReads ??= []).push(login);
  const data = {
    mine: { nodes: world.inbox?.mine ?? [] },
    asked: { nodes: world.inbox?.asked ?? [] },
  };
  return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
}

function serverGh(world: World): Exec {
  return async (args, options) => {
    (world.ghRuns ??= []).push(Date.now());
    if (args[0] === "auth") return fakeAuth(world, args);
    if (args[0] === "api" && args[1] === "--paginate") return fakeRest(world, args);
    const token = options?.env?.GH_TOKEN;
    const login = token ? token.replace(/^tok-/, "") : world.serverAccounts[0]!;
    if (args[0] === "pr" && args[1] === "ready") {
      (world.writes ??= []).push({ login, args });
      if (world.cannotSee?.includes(login))
        return {
          code: 1,
          stdout: "",
          stderr: "GraphQL: Could not resolve to a Repository (HTTP 404)",
        };
      return { code: 0, stdout: "", stderr: "" };
    }
    const body = JSON.parse(String(options?.stdin ?? "{}")) as {
      query?: string;
      variables?: { branch?: string };
    };
    if (body.query?.includes("mine: search")) return fakeInbox(world, login);
    const head = body.variables?.branch ?? "";
    world.ghCalls.push(head);
    (world.readAs ??= []).push(login);
    if (world.cannotSee?.includes(login))
      return {
        code: 0,
        stdout: JSON.stringify({
          data: { repository: null },
          errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
        }),
        stderr: "",
      };
    return {
      code: 0,
      stdout: JSON.stringify({
        data: { repository: { pullRequests: { nodes: world.pullRequests[head] ?? [] } } },
      }),
      stderr: "",
    };
  };
}

/** The host's range reads: one modified file, no commits, a header-only patch per path. */
function fakeRange({ read }: { read: { kind: string; paths?: string[] } }) {
  if (read.kind === "files")
    return {
      ok: true,
      value: {
        kind: "files",
        files: [
          {
            path: "src/a.ts",
            kind: "modified",
            previousPath: null,
            additions: 3,
            deletions: 1,
            binary: false,
          },
        ],
      },
    };
  if (read.kind === "commits") return { ok: true, value: { kind: "commits", commits: [] } };
  return {
    ok: true,
    value: {
      kind: "patches",
      files: (read.paths ?? []).map((path) => ({
        path,
        kind: "modified",
        previousPath: null,
        patch: `diff --git a/${path} b/${path}\n`,
        truncated: false,
      })),
    },
  };
}

async function start(world: World, options: { hostDeadlineMs?: number } = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: PLUGIN,
    sdk: {
      threads: {
        get: (async ({ threadId }: { threadId: string }) => {
          const where = world.threads[threadId]!;
          return {
            ...makeThreadResponse({ id: threadId }),
            environment: {
              id: where.environmentId ?? `env-${threadId}`,
              hostId: where.hostId,
              path: where.path,
              status: "ready",
            },
          };
        }) as never,
      },
      hosts: {
        get: (async ({ hostId }: { hostId: string }) => {
          const host = world.hosts[hostId]!;
          return makeHostResponse({
            id: hostId,
            name: host.name,
            status: host.online ? "connected" : "disconnected",
          } as never);
        }) as never,
      },
    },
    experimental_callHostRpc: async ({ method, hostId, input }) => {
      const host = world.hosts[hostId]!;
      if (!host.online) throw new Error("Host is not connected");
      if (host.hung) return new Promise(() => undefined);
      if (method === "workspace") {
        if (host.delayMs) {
          world.inFlight = (world.inFlight ?? 0) + 1;
          world.maxInFlight = Math.max(world.maxInFlight ?? 0, world.inFlight);
          await new Promise((resolve) => setTimeout(resolve, host.delayMs));
          world.inFlight -= 1;
        }
        return { ok: true, value: { state: "workspace", value: host.workspace } };
      }
      if (method === "range")
        return fakeRange(input as { read: { kind: string; paths?: string[] } });
      if (method === "renewWatch") return { watching: true };
      if (method === "forgeAccounts") return { ok: true, value: { accounts: host.ghAccounts } };
      if (method === "forgeCall") return { ok: true, value: { pullRequest: null, checks: null } };
      if (method === "vcsAction") return host.action ?? { status: "done" };
      if (method === "patches") return { ok: true, value: { files: [] } };
      throw new Error(`unexpected ${method} ${JSON.stringify(input)}`);
    },
  });
  await createSourceControl({ serverExec: serverGh(world), now: () => Date.now(), ...options })(bb);
  const read = async (threadId: string) =>
    (
      (await harness.behavior.callRpc("changeForThread", { keys: [threadId] })) as Record<
        string,
        ThreadChange
      >
    )[threadId]!;
  const checkout = async (threadId: string) => {
    const row = await read(threadId);
    if (row.state !== "checkout") throw new Error(`expected a checkout row, got ${row.state}`);
    return row;
  };
  const hostCalls = (method?: string) =>
    harness.inspection.experimental_hostRpcCalls.filter(
      (call) => method === undefined || call.method === method,
    );
  const invalidations = () =>
    harness.inspection.experimental_rpcInvalidations.flatMap((tags) => tags ?? []);
  return { harness, read, checkout, hostCalls, invalidations };
}

function twoHosts(): World {
  return {
    hosts: {
      "host-a": {
        name: "studio-mac",
        online: true,
        workspace: workspace("/Users/scott/bb-plugins"),
        ghAccounts: [],
      },
      "host-b": {
        name: "build-linux",
        online: true,
        workspace: workspace("/home/scott/bb-plugins"),
        ghAccounts: [],
      },
    },
    threads: {
      "thread-a": { hostId: "host-a", path: "/Users/scott/bb-plugins" },
      "thread-b": { hostId: "host-b", path: "/home/scott/bb-plugins" },
    },
    serverAccounts: ["smsunarto"],
    pullRequests: {},
    ghCalls: [],
  };
}

afterEach(() => vi.useRealTimers());

describe("identity", () => {
  test("one branch on two hosts is one Change, before and after its pull request exists", async () => {
    const world = twoHosts();
    const { harness, checkout } = await start(world);

    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-b" });
    const [a1, b1] = [await checkout("thread-a"), await checkout("thread-b")];
    expect(a1.key).toBe("gh:smsunarto/bb-plugins:smsunarto:scott/route-gh");
    expect(b1.key).toBe(a1.key);
    expect(a1.forge.read?.value).toBeNull();

    world.pullRequests["scott/route-gh"] = [PR];
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-b" });
    const [a2, b2] = [await checkout("thread-a"), await checkout("thread-b")];
    expect(a2.key).toBe(a1.key);
    // The pull request read for B is the same Change's, so A shows it without reading again.
    const pr = a2.forge.read?.value as PullRequest;
    expect(pr).toMatchObject({
      number: 482,
      state: "open",
      isDraft: true,
      checks: { passed: 1, failed: 0, pending: 0 },
    });
    expect(b2.forge.read?.value).toEqual(pr);
  });

  test("a branch tracking a differently named remote branch is the remote branch's Change", async () => {
    const world = twoHosts();
    const renamed = branch({
      name: "route",
      remote: { ref: "origin/scott/route-gh", name: "scott/route-gh" },
    });
    world.hosts["host-a"]!.workspace = workspace("/Users/scott/bb-plugins", {
      checkedOut: "route",
      stacks: [{ key: "route", branches: [renamed], assigned: [] }],
    });
    world.pullRequests["scott/route-gh"] = [PR];
    const { harness, checkout } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-b" });
    const [a, b] = [await checkout("thread-a"), await checkout("thread-b")];
    expect(a.branch).toBe("route");
    expect(a.key).toBe("gh:smsunarto/bb-plugins:smsunarto:scott/route-gh");
    expect(a.key).toBe(b.key);
    expect(a.forge.read?.value).toMatchObject({ number: 482 });
    expect(world.ghCalls).not.toContain("route");
  });

  test("a GitButler thread with one applied branch takes it", async () => {
    const world = twoHosts();
    world.hosts["host-a"]!.workspace = workspace("/Users/scott/bb-plugins", {
      provider: "gitbutler",
      checkedOut: null,
    });
    const { harness, checkout } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    const row = await checkout("thread-a");
    expect(row.branch).toBe("scott/route-gh");
    expect(row.key).toBe("gh:smsunarto/bb-plugins:smsunarto:scott/route-gh");
  });
});

describe("offline", () => {
  test("a disconnected host is served from the last read without a call, while GitHub stays live", async () => {
    const world = twoHosts();
    world.pullRequests["scott/route-gh"] = [PR];
    const { harness, checkout, hostCalls } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    const before = await checkout("thread-a");

    world.hosts["host-a"]!.online = false;
    world.pullRequests["scott/route-gh"] = [{ ...PR, title: "Renamed on GitHub" }];
    const calls = hostCalls().length;
    const started = performance.now();
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(hostCalls()).toHaveLength(calls);

    const after = await checkout("thread-a");
    expect(after.key).toBe(before.key);
    expect(after.local.problem).toEqual({ kind: "host-offline", host: "studio-mac" });
    expect(after.local.read).toEqual(before.local.read);
    expect(after.forge.problem).toBeNull();
    expect(after.forge.read?.value).toMatchObject({ title: "Renamed on GitHub" });
  });

  test("while the host hangs, GitHub's answer lands without waiting for the host deadline", async () => {
    // Every timer is fake, the scheduler's setImmediate included, so only 100 ms pass.
    vi.useFakeTimers();
    const world = twoHosts();
    world.pullRequests["scott/route-gh"] = [PR];
    const { harness, checkout } = await start(world);
    const first = harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    await vi.advanceTimersByTimeAsync(100);
    await first;
    world.hosts["host-a"]!.hung = true;
    world.pullRequests["scott/route-gh"] = [{ ...PR, title: "Seen while the host hangs" }];
    const done = harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    await vi.advanceTimersByTimeAsync(100);
    // GitHub's answer is stored before the host's deadline.
    expect((await checkout("thread-a")).forge.read?.value).toMatchObject({
      title: "Seen while the host hangs",
    });
    void done;
  });
});

test("a host that stops answering is offline once the host deadline passes, though its call has not settled", async () => {
  const world = twoHosts();
  const { harness, checkout } = await start(world, { hostDeadlineMs: 50 });
  await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
  const before = await checkout("thread-a");
  world.hosts["host-a"]!.hung = true;
  const started = performance.now();
  await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
  expect(performance.now() - started).toBeLessThan(1_000);
  const after = await checkout("thread-a");
  expect(after.local.problem).toEqual({ kind: "host-offline", host: "studio-mac" });
  expect(after.local.read).toEqual(before.local.read);
});

describe("forge sites", () => {
  test("without gh on the server, the pull request is read on the checkout's host", async () => {
    const world = twoHosts();
    world.serverAccounts = [];
    world.hosts["host-a"]!.ghAccounts = ["smsunarto"];
    const { harness, checkout, hostCalls } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect((await checkout("thread-a")).forge).toMatchObject({
      read: { value: null },
      problem: null,
    });
    expect(hostCalls("forgeCall").length).toBeGreaterThan(0);
  });

  test("with no signed-in gh anywhere, the forge facet says so and the local facet is unaffected", async () => {
    const world = twoHosts();
    world.serverAccounts = [];
    const { harness, checkout } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    const row = await checkout("thread-a");
    expect(row.forge).toEqual({ read: null, problem: { kind: "no-site", host: "studio-mac" } });
    expect(row.local.problem).toBeNull();
    expect(row.branch).toBe("scott/route-gh");
  });
});

describe("host calls", () => {
  test("serving the read never calls a host, and nothing is read while no surface watches", async () => {
    vi.useFakeTimers();
    const world = twoHosts();
    const { harness, read, hostCalls } = await start(world);
    expect(await read("thread-a")).toEqual({ state: "pending" });
    // A change signalled for a checkout nobody watches is not read either.
    await harness.behavior.experimental_emitHostSignal("host-a", "checkoutChanged", {
      paths: ["/Users/scott/bb-plugins"],
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(hostCalls()).toHaveLength(0);
  });

  test("a watched thread calls only its own host, is read again on a change signal and never on a timer", async () => {
    vi.useFakeTimers();
    const world = twoHosts();
    const { harness, checkout, hostCalls } = await start(world);
    const stop = harness.behavior.experimental_watchRpc("changeForThread", { key: "thread-a" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(hostCalls("workspace")).toHaveLength(1);
    expect(hostCalls("renewWatch").length).toBeGreaterThanOrEqual(4);
    expect(new Set(hostCalls().map((call) => call.hostId))).toEqual(new Set(["host-a"]));

    world.hosts["host-a"]!.workspace = workspace("/Users/scott/bb-plugins", {
      uncommitted: [
        { path: "src/a.ts", kind: "modified" },
        { path: "src/b.ts", kind: "added" },
      ],
    });
    await harness.behavior.experimental_emitHostSignal("host-a", "checkoutChanged", {
      paths: ["/Users/scott/bb-plugins"],
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(hostCalls("workspace")).toHaveLength(2);
    expect((await checkout("thread-a")).local.read?.value.uncommitted).toHaveLength(2);

    stop();
    await vi.advanceTimersByTimeAsync(1);
    const after = hostCalls().length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(hostCalls()).toHaveLength(after);
  });

  test("two threads on one checkout share one host read", async () => {
    const world = twoHosts();
    world.threads["thread-a2"] = { hostId: "host-a", path: "/Users/scott/bb-plugins" };
    const { harness, checkout, hostCalls } = await start(world);
    await Promise.all([
      harness.behavior.callRpc("refreshThread", { threadId: "thread-a" }),
      harness.behavior.callRpc("refreshThread", { threadId: "thread-a2" }),
    ]);
    expect(hostCalls("workspace")).toHaveLength(1);
    expect((await checkout("thread-a2")).local.read?.value.path).toBe("/Users/scott/bb-plugins");
  });
});

describe("publishing", () => {
  test("an unchanged refresh publishes nothing; a changed checkout publishes its threads, its host's list and its Changes", async () => {
    const world = twoHosts();
    world.threads["thread-a2"] = { hostId: "host-a", path: "/Users/scott/bb-plugins" };
    world.pullRequests["scott/route-gh"] = [PR];
    const { harness, invalidations, hostCalls } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a2" });
    const published = invalidations().length;
    const reads = hostCalls("workspace").length;

    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect(hostCalls("workspace").length).toBeGreaterThan(reads);
    expect(invalidations()).toHaveLength(published);

    world.hosts["host-a"]!.workspace = workspace("/Users/scott/bb-plugins", { uncommitted: [] });
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect(new Set(invalidations().slice(published))).toEqual(
      new Set([
        "thread:thread-a",
        "thread:thread-a2",
        "host:host-a",
        "change:gh:smsunarto/bb-plugins:smsunarto:scott/route-gh",
      ]),
    );
  });
});

describe("forge budget", () => {
  const RUNNING = {
    ...PR,
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }],
              },
            },
          },
        },
      ],
    },
  };

  /** The most `gh` runs any minute saw, by the fake clock. */
  function busiestMinute(runs: readonly number[]): number {
    return Math.max(
      0,
      ...runs.map((at) => runs.filter((other) => other >= at && other < at + 60_000).length),
    );
  }

  test("nothing calls GitHub while no surface watches", async () => {
    vi.useFakeTimers();
    const world = twoHosts();
    world.pullRequests["scott/route-gh"] = [RUNNING];
    const { harness, hostCalls } = await start(world);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await harness.behavior.experimental_emitHostSignal("host-a", "checkoutChanged", {
      paths: ["/Users/scott/bb-plugins"],
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(world.ghRuns ?? []).toHaveLength(0);
    expect(hostCalls("forgeCall")).toHaveLength(0);
  });

  test.each([
    ["an idle change", PR, 1],
    ["a change whose checks run", RUNNING, 3],
  ])("%s stays within 5 gh runs a minute while watched", async (_name, pr, perMinute) => {
    vi.useFakeTimers();
    const world = twoHosts();
    world.pullRequests["scott/route-gh"] = [pr];
    const { harness } = await start(world);
    const stop = harness.behavior.experimental_watchRpc("changeForThread", { key: "thread-a" });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    stop();
    const runs = world.ghRuns ?? [];
    expect(busiestMinute(runs)).toBeLessThanOrEqual(5);
    // Pull request reads alone, once the first read is past.
    const reads = world.ghCalls.length;
    expect(reads).toBeGreaterThanOrEqual(perMinute * 29);
    expect(reads).toBeLessThanOrEqual(perMinute * 31 + 1);
  });
});

describe("accounts", () => {
  function twoAccounts() {
    const world = twoHosts();
    world.serverAccounts = ["smsunarto", "sms-yui"];
    world.cannotSee = ["smsunarto"];
    world.pullRequests["scott/route-gh"] = [PR];
    return world;
  }
  const markReady = (head: string) => ({
    threadId: "thread-a",
    action: { kind: "setDraft" as const, draft: false },
    expected: { number: 482, head },
  });

  test("a repository is read with the account that can see it, and then with that one only", async () => {
    const world = twoAccounts();
    const { harness, checkout } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect(world.readAs).toEqual(["smsunarto", "sms-yui"]);
    expect((await checkout("thread-a")).forge.read?.value).toMatchObject({ number: 482 });
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect(world.readAs).toEqual(["smsunarto", "sms-yui", "sms-yui"]);
  });

  test("Mark ready runs as the account that read the pull request, and never falls back to another", async () => {
    const world = twoAccounts();
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect(await harness.behavior.callRpc("forgeAction", markReady("c0ffee"))).toEqual({
      status: "done",
    });
    expect(world.writes).toEqual([
      { login: "sms-yui", args: ["pr", "ready", "482", "--repo", "smsunarto/bb-plugins"] },
    ]);

    // The account that read it loses access: the write fails rather than trying smsunarto.
    world.cannotSee = ["sms-yui"];
    const reads = world.readAs!.length;
    const result = await harness.behavior.callRpc("forgeAction", markReady("c0ffee"));
    expect(result).toMatchObject({ status: "failed" });
    expect(world.writes!.map((write) => write.login)).toEqual(["sms-yui"]);
    expect(world.readAs!.slice(reads, reads + 1)).toEqual(["sms-yui"]);
  });

  test("Mark ready against a stale head is a conflict and writes nothing", async () => {
    const world = twoAccounts();
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect(await harness.behavior.callRpc("forgeAction", markReady("0ld"))).toEqual({
      status: "conflict",
      detail: "#482 moved to c0ffee since you looked.",
    });
    expect(world.writes ?? []).toEqual([]);
  });

  test("Mark ready on a pull request already ready is up to date, so a retry is safe", async () => {
    const world = twoAccounts();
    world.pullRequests["scott/route-gh"] = [{ ...PR, isDraft: false }];
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect(await harness.behavior.callRpc("forgeAction", markReady("c0ffee"))).toEqual({
      status: "upToDate",
    });
    expect(world.writes ?? []).toEqual([]);
  });
});

describe("checks", () => {
  test("the checks facet holds each check of the head, read with the pull request in one call", async () => {
    const world = twoHosts();
    world.pullRequests["scott/route-gh"] = [
      {
        ...PR,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    pageInfo: { hasNextPage: false },
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "test",
                        status: "IN_PROGRESS",
                        conclusion: null,
                        detailsUrl: "https://github.com/run/1",
                        startedAt: "2026-11-10T01:00:00Z",
                        completedAt: null,
                        checkSuite: { workflowRun: { workflow: { name: "CI" } } },
                      },
                      {
                        __typename: "StatusContext",
                        context: "deploy/preview",
                        state: "FAILURE",
                        targetUrl: null,
                        createdAt: "2026-11-10T01:01:00Z",
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    ];
    const { harness, checkout, invalidations } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect(world.ghCalls).toHaveLength(1);
    const row = await checkout("thread-a");
    expect(row.forge.read?.value).toMatchObject({ checks: { passed: 0, failed: 1, pending: 1 } });
    const checks = (await harness.behavior.callRpc("checksForChange", {
      keys: [row.key!],
    })) as Record<string, { read: { value: unknown } | null }>;
    expect(checks[row.key!]!.read?.value).toEqual({
      head: "c0ffee",
      more: false,
      rows: [
        {
          name: "test",
          workflow: "CI",
          outcome: "pending",
          url: "https://github.com/run/1",
          startedAt: "2026-11-10T01:00:00Z",
          completedAt: null,
        },
        {
          name: "deploy/preview",
          workflow: null,
          outcome: "failed",
          url: null,
          startedAt: "2026-11-10T01:01:00Z",
          completedAt: null,
        },
      ],
    });
    expect(invalidations()).toContain(`change:${row.key}:checks`);
  });
});

describe("status for other surfaces", () => {
  test("a list row reads a thread once, stays quiet while fresh, and is small", async () => {
    vi.useFakeTimers();
    const world = twoHosts();
    world.pullRequests["scott/route-gh"] = [PR];
    const { harness, hostCalls } = await start(world);
    const stop = harness.behavior.experimental_watchRpc("statusForThread", { key: "thread-a" });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    stop();
    expect(hostCalls("workspace")).toHaveLength(1);
    expect(world.ghCalls).toHaveLength(1);
    const rows = (await harness.behavior.callRpc("statusForThread", {
      keys: ["thread-a"],
    })) as Record<string, unknown>;
    expect(rows["thread-a"]).toMatchObject({
      state: "change",
      pullRequest: { number: 482, state: "draft" },
      line: "Draft",
      chips: [{ label: "Passed" }],
    });
    expect(JSON.stringify(rows["thread-a"]).length).toBeLessThan(2_048);

    // Mounted again within five minutes of the read: nothing more.
    const again = harness.behavior.experimental_watchRpc("statusForThread", { key: "thread-a" });
    await vi.advanceTimersByTimeAsync(10);
    again();
    expect(hostCalls("workspace")).toHaveLength(1);
    // Past five minutes: read once more.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const later = harness.behavior.experimental_watchRpc("statusForThread", { key: "thread-a" });
    await vi.advanceTimersByTimeAsync(10);
    later();
    expect(hostCalls("workspace")).toHaveLength(2);
  });
});

describe("writes", () => {
  test("a write the host refuses as stale reports conflict, is not retried, and reloads the checkout", async () => {
    const world = twoHosts();
    world.hosts["host-a"]!.action = { status: "conflict", detail: "scott/route-gh moved." };
    const { harness, hostCalls } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    const reads = hostCalls("workspace").length;
    const result = await harness.behavior.callRpc("vcsAction", {
      threadId: "thread-a",
      action: { kind: "push", branch: "scott/route-gh", force: false, acceptedLoss: [] },
      expected: { head: "0ld", target: "aaa111" },
    });
    expect(result).toEqual({ status: "conflict", detail: "scott/route-gh moved." });
    expect(hostCalls("vcsAction")).toHaveLength(1);
    expect(hostCalls("vcsAction")[0]!.input).toMatchObject({ expected: { head: "0ld" } });
    await vi.waitFor(() => expect(hostCalls("workspace").length).toBeGreaterThan(reads));
  });

  test("a write to a thread whose checkout moved is refused before reaching any host", async () => {
    const world = twoHosts();
    const { harness, hostCalls } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    world.threads["thread-a"] = { hostId: "host-b", path: "/home/scott/bb-plugins" };
    const result = await harness.behavior.callRpc("vcsAction", {
      threadId: "thread-a",
      action: { kind: "pull", accepted: null },
      expected: { head: null, target: "aaa111" },
    });
    expect(result).toMatchObject({ status: "failed", problem: { kind: "moved" } });
    expect(hostCalls("vcsAction")).toHaveLength(0);
  });

  test("Read as plain git is stored per checkout and sent with each read", async () => {
    const world = twoHosts();
    const { harness, checkout, hostCalls } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    await harness.behavior.callRpc("setReadAs", { threadId: "thread-a", readAs: "git" });
    expect(hostCalls("workspace").at(-1)!.input).toMatchObject({ readAs: "git" });
    expect((await checkout("thread-a")).readAsGit).toBe(true);
    // Read as plain git, writes are off: they would act on GitButler's own branch.
    const result = await harness.behavior.callRpc("vcsAction", {
      threadId: "thread-a",
      action: { kind: "pull", accepted: null },
      expected: { head: null, target: "aaa111" },
    });
    expect(result).toMatchObject({ status: "failed" });
    expect(hostCalls("vcsAction")).toHaveLength(0);
  });
});

describe("review page", () => {
  /** Five hosts with a thread's checkout each, and a sixth connected host with none. */
  function sixHosts(): World {
    const world: World = { ...twoHosts(), hosts: {}, threads: {} };
    for (let n = 1; n <= 6; n++) {
      const path = `/srv/h${n}/bb-plugins`;
      world.hosts[`h${n}`] = {
        name: `host-${n}`,
        online: true,
        delayMs: 2_000,
        workspace: workspace(path),
        ghAccounts: [],
      };
      if (n <= 5) world.threads[`t${n}`] = { hostId: `h${n}`, path };
    }
    return world;
  }

  test("opening the page calls only the placement table's hosts, three at a time, and nothing once hidden", async () => {
    vi.useFakeTimers();
    const world = sixHosts();
    const { harness, hostCalls } = await start(world);
    // Thread events place each thread; nothing lists hosts.
    for (let n = 1; n <= 5; n++) {
      const read = harness.behavior.callRpc("refreshThread", { threadId: `t${n}` });
      await vi.advanceTimersByTimeAsync(2_500);
      await read;
    }
    const sources = (await harness.behavior.callRpc("pageSources", {})) as {
      hosts: { hostId: string }[];
    };
    expect(sources.hosts.map((host) => host.hostId)).toEqual(["h1", "h2", "h3", "h4", "h5"]);

    world.maxInFlight = 0;
    const before = hostCalls("workspace").length;
    const stops = sources.hosts.map((host) =>
      harness.behavior.experimental_watchRpc("hostChanges", { key: host.hostId }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const opened = hostCalls("workspace").slice(before);
    expect(new Set(opened.map((call) => call.hostId))).toEqual(
      new Set(["h1", "h2", "h3", "h4", "h5"]),
    );
    expect(world.maxInFlight).toBe(3);

    for (const stop of stops) stop();
    await vi.advanceTimersByTimeAsync(2_000);
    const hidden = hostCalls().length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(hostCalls().length).toBe(hidden);
    expect(hostCalls().some((call) => call.hostId === "h6")).toBe(false);
  });

  const INBOX_PR = {
    ...PR,
    number: 77,
    url: "https://github.com/acme/api/pull/77",
    title: "Asked of me",
    isDraft: false,
    headRefName: "fix/retry",
    headRefOid: "beef01",
    updatedAt: "2026-11-09T10:00:00Z",
    mergeable: "MERGEABLE",
    additions: 5,
    deletions: 2,
    changedFiles: 2,
    author: { login: "someone" },
    repository: { name: "api", owner: { login: "acme" } },
    headRepositoryOwner: { login: "acme" },
  };

  test("an account's inbox is read once a minute while watched, and never while not", async () => {
    vi.useFakeTimers();
    const world = twoHosts();
    world.inbox = { mine: [], asked: [INBOX_PR] };
    const { harness } = await start(world);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(world.inboxReads ?? []).toEqual([]);

    const stop = harness.behavior.experimental_watchRpc("inbox", { key: "smsunarto" });
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    stop();
    const reads = world.inboxReads!.length;
    expect(reads).toBeGreaterThanOrEqual(10);
    expect(reads).toBeLessThanOrEqual(12);
    const rows = (await harness.behavior.callRpc("inbox", { keys: ["smsunarto"] })) as Record<
      string,
      { read: { rows: { key: string; asked: boolean; mine: boolean; line: string }[] } }
    >;
    expect(rows.smsunarto!.read.rows).toEqual([
      expect.objectContaining({
        key: "gh:acme/api:acme:fix/retry",
        asked: true,
        mine: false,
        line: "Review requested",
      }),
    ]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(world.inboxReads!.length).toBe(reads);
  });

  test("a pull request with no checkout anywhere opens and reads entirely from GitHub", async () => {
    vi.useFakeTimers();
    const world = twoHosts();
    world.pullRequests["fix/retry"] = [INBOX_PR];
    const files = [
      {
        filename: "src/retry.ts",
        status: "modified",
        additions: 4,
        deletions: 1,
        patch: "@@ -1 +1,4 @@\n-a\n+b\n+c\n+d\n+e",
      },
      { filename: "package-lock.json", status: "modified", additions: 1, deletions: 1 },
    ];
    world.rest = { "repos/acme/api/pulls/77/files?per_page=100": [files] };
    const { harness, hostCalls } = await start(world);
    const key = "gh:acme/api:acme:fix/retry";
    const stop = harness.behavior.experimental_watchRpc("changeDetail", { key });
    await vi.advanceTimersByTimeAsync(1_000);
    const detail = (
      (await harness.behavior.callRpc("changeDetail", { keys: [key] })) as Record<string, any>
    )[key];
    stop();
    expect(detail).toMatchObject({
      state: "change",
      row: { number: 77, title: "Asked of me", state: "open" },
      revision: { head: "beef01", source: { kind: "forge", number: 77 } },
      files: 2,
      additions: 5,
      deletions: 2,
    });
    expect(detail.ship.map((step: { state: string }) => step.state).slice(0, 2)).toEqual([
      "done",
      "done",
    ]);

    const listed = await harness.behavior.callRpc("changeFiles", {
      key,
      revision: detail.revision,
    });
    expect(listed).toMatchObject({
      ok: true,
      files: [{ path: "src/retry.ts", additions: 4 }, { path: "package-lock.json" }],
    });
    const patches = (await harness.behavior.callRpc("changePatches", {
      key,
      revision: detail.revision,
      paths: ["src/retry.ts"],
    })) as { ok: true; value: { files: { patch: string }[] } };
    expect(patches.value.files[0]!.patch).toContain("diff --git a/src/retry.ts b/src/retry.ts");
    // One files read per revision: the patches came from it.
    expect(world.restReads).toEqual(["repos/acme/api/pulls/77/files?per_page=100"]);
    expect(hostCalls()).toEqual([]);
  });

  test("a checkout's revision is read from its host once, then served from memory", async () => {
    const world = twoHosts();
    world.hosts["host-a"]!.workspace = workspace("/Users/scott/bb-plugins", {
      target: { ref: "origin/main", head: "aaa1111", behind: 0, base: null, lastFetched: null },
    });
    world.pullRequests["scott/route-gh"] = [PR];
    const { harness, hostCalls } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    const key = "gh:smsunarto/bb-plugins:smsunarto:scott/route-gh";
    const detail = (
      (await harness.behavior.callRpc("changeDetail", { keys: [key] })) as Record<string, any>
    )[key];
    expect(detail.revision).toEqual({
      head: "c0ffee",
      base: "aaa1111",
      source: { kind: "host", hostId: "host-a", path: "/Users/scott/bb-plugins" },
    });
    const ask = () => harness.behavior.callRpc("changeFiles", { key, revision: detail.revision });
    expect(await ask()).toMatchObject({ ok: true, files: [{ path: "src/a.ts" }] });
    expect(await ask()).toMatchObject({ ok: true });
    expect(hostCalls("range")).toHaveLength(1);
  });
});
