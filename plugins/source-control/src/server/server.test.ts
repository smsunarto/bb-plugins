import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type {
  Branch,
  PullRequest,
  ThreadChange,
  VcsResult,
  WorkspaceValue,
} from "../core/change.ts";
import { resolveGuide, viewedAtHead, type GuideView } from "../core/guide.ts";
import type { ChangeFile, ReviewRevision } from "../core/review.ts";
import { readPullRequest, type Exec } from "../forge/github.ts";
import { runReviewRead } from "../forge/review.ts";
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

/** A pull request asked of the viewer, with no checkout anywhere. */
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

type Host = {
  name: string;
  online: boolean;
  /** Never answers while true, as a host that stopped responding. */
  hung?: boolean;
  /** Answers each workspace read after this long, by the fake clock. */
  delayMs?: number;
  /** Never answers a range read, while its workspace reads still answer. */
  rangeHung?: boolean;
  /** A range read's patch text by path, between whatever two commits were asked. */
  patches?: Record<string, string>;
  /** A range read's file list, in place of one modified `src/a.ts`. */
  files?: unknown[];
  /** Answers workspace reads with this failure, as a host missing a tool. */
  failure?: { code: string; message: string };
  /** Runs GitHub reads itself, against the world's fake GitHub, as its `ghAccounts`. */
  forgeLive?: boolean;
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
  /** GitHub reads a host ran, as `<hostId>:<kind>`. */
  hostForge?: string[];
  /** Host workspace reads in flight now, and the most at once. */
  inFlight?: number;
  maxInFlight?: number;
  /** code-review is still enabled and running, as before the cutover. */
  codeReviewRunning?: boolean;
  /** Threads the plugin spawned, with what it asked for. */
  spawned?: {
    id: string;
    pluginMetadata: unknown;
    prompt: string;
    environment: unknown;
    visibility?: string;
  }[];
  /** Threads the plugin forked, with what it asked for. */
  forked?: { id: string; sourceThreadId: string; [field: string]: unknown }[];
  /** Thread updates the plugin made. */
  updated?: { threadId: string; visibility?: string }[];
  /** bb projects, for a Change with no checkout. */
  projects?: unknown[];
  /** Threads bb reports idle: stopped since the plugin last heard. */
  idle?: string[];
  /** Messages each thread received, in order. */
  messages?: Record<string, string[]>;
  /**
   * How the next sends go: "lost" records the message then throws, as a
   * server that died before bb answered; "hang" records it and never answers;
   * "refuse" throws without recording.
   */
  sendAs?: ("ok" | "lost" | "hang" | "refuse")[];
  /** Threads the plugin stopped. */
  stopped?: string[];
  /** Reviews posted to each pull request's REST path, and how the next posts go. */
  reviews?: Record<
    string,
    { body: string; html_url: string; commit_id: string; comments: unknown[] }[]
  >;
  postAs?: ("ok" | "lost")[];
  /** GitHub's merge side: the repository's methods, the viewer's permission, and how merges go. */
  merge?: {
    methods?: ("merge" | "squash" | "rebase")[];
    permission?: string;
    mergeState?: string;
    /** "lost": GitHub merged, but the answer never came back. */
    answer?: "ok" | "refused" | "lost";
  };
  /** Merges GitHub was asked for, as whom and with what. */
  merged?: { login: string; path: string; body: unknown }[];
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

/** A host's workspace read, after its delay, counting the reads in flight. */
async function fakeWorkspace(world: World, host: Host) {
  if (host.delayMs) {
    world.inFlight = (world.inFlight ?? 0) + 1;
    world.maxInFlight = Math.max(world.maxInFlight ?? 0, world.inFlight);
    await new Promise((resolve) => setTimeout(resolve, host.delayMs));
    world.inFlight -= 1;
  }
  if (host.failure) return { ok: false, error: host.failure };
  return { ok: true, value: { state: "workspace", value: host.workspace } };
}

/** A host running GitHub reads itself, against the world's fake GitHub. */
async function liveHostForge(world: World, hostId: string, method: string, input: unknown) {
  if (method === "forgeReview") {
    const { read } = input as { read: Parameters<typeof runReviewRead>[1] };
    (world.hostForge ??= []).push(`${hostId}:${read.kind}`);
    return { ok: true, value: await runReviewRead(hostGh(world, hostId), read) };
  }
  (world.hostForge ??= []).push(`${hostId}:pr`);
  const query = input as Parameters<typeof readPullRequest>[1];
  return { ok: true, value: await readPullRequest(hostGh(world, hostId), query) };
}

/** A host's `gh`: the same fake GitHub, its inbox searches recorded by host. */
function hostGh(world: World, hostId: string): Exec {
  const github = serverGh(world);
  return async (args, options) => {
    const body = JSON.parse(String(options?.stdin ?? "{}")) as { query?: string };
    if (body.query?.includes("mine: search")) return fakeInbox(world, hostId);
    return github(args, options);
  };
}

/** GitHub's reviews of a pull request: listing them, and posting one. */
function fakeReviews(world: World, args: readonly string[], stdin: unknown): Run | null {
  const path = args.find((arg) => /\/pulls\/\d+\/reviews/.test(arg))?.replace(/\?.*$/, "");
  if (!path) return null;
  const reviews = ((world.reviews ??= {})[path] ??= []);
  if (args[1] === "--paginate") return { code: 0, stdout: JSON.stringify([reviews]), stderr: "" };
  const posted = JSON.parse(String(stdin)) as {
    body: string;
    commit_id: string;
    comments: unknown[];
  };
  reviews.push({ ...posted, html_url: `https://github.com/${path}#${reviews.length + 1}` });
  if (world.postAs?.shift() === "lost")
    return { code: 1, stdout: "", stderr: "gh: HTTP 502: Bad Gateway" };
  return { code: 0, stdout: JSON.stringify(reviews.at(-1)), stderr: "" };
}

/** Every pull request the world holds, open ones by head branch. */
const allPullRequests = (world: World) =>
  Object.values(world.pullRequests).flat() as { number: number; [key: string]: unknown }[];

/** GitHub's merge policy query and REST merge, against the world's pull requests. */
function fakeMerge(
  world: World,
  args: readonly string[],
  options: Parameters<Exec>[1],
): Run | null {
  const stdin = options?.stdin;
  const login = options?.env?.GH_TOKEN?.replace(/^tok-/, "") ?? world.serverAccounts[0]!;
  const body = JSON.parse(String(stdin ?? "{}")) as {
    query?: string;
    variables?: { number?: number };
  };
  if (body.query?.includes("query MergePolicy")) {
    const pr = allPullRequests(world).find((each) => each.number === body.variables?.number);
    const methods = world.merge?.methods ?? ["merge", "squash", "rebase"];
    const repository = {
      mergeCommitAllowed: methods.includes("merge"),
      squashMergeAllowed: methods.includes("squash"),
      rebaseMergeAllowed: methods.includes("rebase"),
      viewerPermission: world.merge?.permission ?? "WRITE",
      pullRequest: pr && {
        state: pr.state,
        isDraft: pr.isDraft,
        headRefOid: pr.headRefOid,
        baseRefName: pr.baseRefName,
        mergeStateStatus: world.merge?.mergeState ?? "CLEAN",
      },
    };
    return { code: 0, stdout: JSON.stringify({ data: { repository } }), stderr: "" };
  }
  const path = args.find((arg) => /\/pulls\/\d+\/merge$/.test(arg));
  if (args[0] !== "api" || !path) return null;
  const sent = JSON.parse(String(stdin)) as { sha: string; merge_method: string };
  (world.merged ??= []).push({ login, path, body: sent });
  const answer = world.merge?.answer ?? "ok";
  if (answer === "refused")
    return {
      code: 1,
      stdout: JSON.stringify({
        message: "Head branch was modified. Review and try the merge again.",
      }),
      stderr: "gh: Head branch was modified. Review and try the merge again. (HTTP 409)",
    };
  const number = Number(path.split("/").at(-2));
  for (const pr of allPullRequests(world)) if (pr.number === number) pr.state = "MERGED";
  if (answer === "lost") return { code: 1, stdout: "", stderr: "gh: HTTP 502: Bad Gateway" };
  return {
    code: 0,
    stdout: JSON.stringify({
      sha: "m3rg3d",
      merged: true,
      message: "Pull Request successfully merged",
    }),
    stderr: "",
  };
}

/** GitHub's REST side and merges: a merge, a pull request's reviews, or paginated reads. */
function fakeApi(world: World, args: readonly string[], options: Parameters<Exec>[1]): Run | null {
  const merge = fakeMerge(world, args, options);
  if (merge) return merge;
  if (args[0] !== "api") return null;
  const review = fakeReviews(world, args, options?.stdin);
  if (review) return review;
  return args[1] === "--paginate" ? fakeRest(world, args) : null;
}

function serverGh(world: World): Exec {
  return async (args, options) => {
    (world.ghRuns ??= []).push(Date.now());
    if (args[0] === "auth") return fakeAuth(world, args);
    const special = fakeApi(world, args, options);
    if (special) return special;
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

/** The host's range reads: one modified file, no commits, a header-only patch per path unless the host has one. */
function fakeRange(
  { read }: { read: { kind: string; paths?: string[] } },
  patches: Record<string, string> = {},
  files?: unknown[],
) {
  if (read.kind === "files")
    return {
      ok: true,
      value: {
        kind: "files",
        files: files ?? [
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
        patch: patches[path] ?? `diff --git a/${path} b/${path}\n`,
        truncated: false,
      })),
    },
  };
}

function fakeSdk(world: World) {
  return {
    // By default code-review is gone: Source Control's watch and landed services run.
    plugins: {
      list: (async () => ({
        plugins: world.codeReviewRunning
          ? [{ id: "code-review", enabled: true, status: "running" }]
          : [],
      })) as never,
    },
    threads: {
      get: (async ({ threadId }: { threadId: string }) => {
        if (world.idle?.includes(threadId))
          return makeThreadResponse({ id: threadId, status: "idle" } as never);
        const where = world.threads[threadId];
        if (!where) return makeThreadResponse({ id: threadId, status: "active" } as never);
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
      spawn: (async (args: { pluginMetadata: unknown; prompt: string; environment: unknown }) => {
        const id = `review-${(world.spawned ??= []).length + 1}`;
        world.spawned.push({ id, ...args });
        return makeThreadResponse({ id, status: "active" } as never);
      }) as never,
      send: (async ({ threadId, input }: { threadId: string; input: { text: string }[] }) => {
        const how = world.sendAs?.shift() ?? "ok";
        if (how === "refuse") throw new Error("Thread is not reachable");
        // Another call can run while this one waits, as on a real server.
        await new Promise((resolve) => setTimeout(resolve, 1));
        ((world.messages ??= {})[threadId] ??= []).push(input.map((part) => part.text).join(""));
        if (how === "hang") return new Promise(() => undefined);
        if (how === "lost") throw new Error("socket hang up");
        return { ok: true };
      }) as never,
      fork: (async (args: { sourceThreadId: string }) => {
        // Slow enough for a second question to arrive while the first forks.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const id = `ask-${(world.forked ??= []).length + 1}`;
        world.forked.push({ id, ...args });
        return makeThreadResponse({ id, status: "active" } as never);
      }) as never,
      update: (async (args: { threadId: string; visibility?: string }) => {
        (world.updated ??= []).push(args);
        return makeThreadResponse({ id: args.threadId } as never);
      }) as never,
      promptHistory: (async ({ threadId }: { threadId: string }) => ({
        prompts: (world.messages?.[threadId] ?? []).map((text) => ({ text })),
      })) as never,
      queuedMessages: {
        list: (async () => ({ messages: [] })) as never,
      },
      stop: (async ({ threadId }: { threadId: string }) => {
        (world.stopped ??= []).push(threadId);
        return { ok: true };
      }) as never,
    },
    projects: { list: (async () => world.projects ?? []) as never },
    environments: {
      get: (async ({ environmentId }: { environmentId: string }) => ({
        id: environmentId,
        projectId: "proj-1",
        status: "ready",
      })) as never,
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
  };
}

async function start(world: World, options: { hostDeadlineMs?: number } = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: PLUGIN,
    agentSkillIds: ["request-review", "babysit-pr"],
    sdk: fakeSdk(world),
    experimental_callHostRpc: async ({ method, hostId, input }) => {
      const host = world.hosts[hostId]!;
      if (!host.online) throw new Error("Host is not connected");
      if (host.hung) return new Promise(() => undefined);
      if (method === "workspace") return fakeWorkspace(world, host);
      if (method === "range")
        return host.rangeHung
          ? new Promise(() => undefined)
          : fakeRange(
              input as { read: { kind: string; paths?: string[] } },
              host.patches,
              host.files,
            );
      if (method === "renewWatch") return { watching: true };
      if (method === "forgeAccounts") return { ok: true, value: { accounts: host.ghAccounts } };
      if (host.forgeLive && (method === "forgeReview" || method === "forgeCall"))
        return liveHostForge(world, hostId, method, input);
      if (method === "forgeCall")
        return { ok: true, value: { pullRequest: null, checks: null, threads: null } };
      if (method === "vcsAction") return host.action ?? { status: "done" };
      if (method === "patches") return { ok: true, value: { files: [] } };
      throw new Error(`unexpected ${method} ${JSON.stringify(input)}`);
    },
  });
  const plugin = createSourceControl({
    serverExec: serverGh(world),
    now: () => Date.now(),
    ...options,
  });
  await plugin(bb);
  // bb starts services once the plugin is active; watches wait for that.
  harness.runService("activation");
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
  /** Stop this plugin instance and load another on the same database, as a server restart. */
  const restart = async () => {
    const next = (await harness.lifecycle.reload(plugin)).harness;
    next.runService("activation");
    return next;
  };
  return { harness, read, checkout, hostCalls, invalidations, restart };
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

describe("merge", () => {
  function ready() {
    const world = twoHosts();
    world.serverAccounts = ["smsunarto", "sms-yui"];
    world.cannotSee = ["smsunarto"];
    world.pullRequests["scott/route-gh"] = [{ ...PR, isDraft: false }];
    return world;
  }
  const merge = (head: string, base = "main", method: "squash" | "merge" = "squash") => ({
    threadId: "thread-a",
    action: { kind: "merge" as const, method, base },
    expected: { number: 482, head },
  });
  const KEY = "gh:smsunarto/bb-plugins:smsunarto:scott/route-gh";

  test("Merge reads the policy as the account that read the pull request, and merges pinned to its head", async () => {
    const world = ready();
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect(await harness.behavior.callRpc("mergePolicy", { key: KEY, number: 482 })).toEqual({
      ok: true,
      policy: {
        state: "OPEN",
        isDraft: false,
        headRefOid: "c0ffee",
        baseRefName: "main",
        mergeStateStatus: "CLEAN",
        canMerge: true,
        methods: ["merge", "squash", "rebase"],
      },
    });
    expect(await harness.behavior.callRpc("forgeAction", merge("c0ffee"))).toEqual({
      status: "done",
    });
    expect(world.merged).toEqual([
      {
        login: "sms-yui",
        path: "repos/smsunarto/bb-plugins/pulls/482/merge",
        body: { sha: "c0ffee", merge_method: "squash" },
      },
    ]);
  });

  test("a moved head or base is a conflict, and GitHub is not asked to merge", async () => {
    const world = ready();
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect(await harness.behavior.callRpc("forgeAction", merge("0ld"))).toEqual({
      status: "conflict",
      detail: "#482 moved to c0ffee since you looked.",
    });
    expect(await harness.behavior.callRpc("forgeAction", merge("c0ffee", "release"))).toEqual({
      status: "conflict",
      detail: "#482 now targets main, not release.",
    });
    expect(world.merged ?? []).toEqual([]);
  });

  test("an unmet requirement fails with GitHub's reason and merges nothing", async () => {
    const world = ready();
    world.merge = { mergeState: "BLOCKED" };
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect(await harness.behavior.callRpc("forgeAction", merge("c0ffee"))).toMatchObject({
      status: "failed",
      problem: {
        kind: "failed",
        detail: expect.stringContaining("GitHub blocks merging: BLOCKED"),
      },
    });
    world.merge = { methods: ["merge"] };
    expect(await harness.behavior.callRpc("forgeAction", merge("c0ffee"))).toMatchObject({
      status: "failed",
      problem: { detail: "This repository does not allow that merge method." },
    });
    world.merge = { permission: "READ" };
    expect(await harness.behavior.callRpc("forgeAction", merge("c0ffee"))).toMatchObject({
      status: "failed",
      problem: { detail: "This account cannot merge this pull request." },
    });
    expect(world.merged ?? []).toEqual([]);
  });

  test("a lost answer is never retried; asking again finds the pull request merged", async () => {
    const world = ready();
    world.merge = { answer: "lost" };
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect(await harness.behavior.callRpc("forgeAction", merge("c0ffee"))).toMatchObject({
      status: "failed",
    });
    expect(world.merged).toHaveLength(1);
    expect(await harness.behavior.callRpc("forgeAction", merge("c0ffee"))).toEqual({
      status: "upToDate",
    });
    expect(world.merged).toHaveLength(1);
  });

  test("GitHub refusing at merge time (the head moved under it) fails and is not retried", async () => {
    const world = ready();
    world.merge = { answer: "refused" };
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect(await harness.behavior.callRpc("forgeAction", merge("c0ffee"))).toMatchObject({
      status: "failed",
      problem: { detail: expect.stringContaining("Head branch was modified") },
    });
    expect(world.merged).toHaveLength(1);
  });

  test("the review page merges a Change by its key", async () => {
    const world = ready();
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect(
      await harness.behavior.callRpc("changeForgeAction", {
        key: KEY,
        action: { kind: "merge", method: "merge", base: "main" },
        expected: { number: 482, head: "c0ffee" },
      }),
    ).toEqual({ status: "done" });
    expect(world.merged).toMatchObject([{ body: { merge_method: "merge" } }]);
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

  test("a server with no gh login reads the inbox, a pull request and its files through a host that has the account", async () => {
    const world = twoHosts();
    world.serverAccounts = [];
    world.hosts["host-a"]!.ghAccounts = ["smsunarto"];
    world.hosts["host-a"]!.forgeLive = true;
    world.inbox = { mine: [], asked: [INBOX_PR] };
    world.pullRequests["fix/retry"] = [INBOX_PR];
    world.rest = {
      "repos/acme/api/pulls/77/files?per_page=100": [
        [
          {
            filename: "src/retry.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            patch: "@@ -1 +1,2 @@\n a\n+b",
          },
        ],
      ],
    };
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    vi.useFakeTimers();
    const accounts = async () =>
      ((await harness.behavior.callRpc("pageSources", {})) as { accounts: { login: string }[] })
        .accounts;
    // The thread's own pull request read already found the host's account.
    await accounts();
    await vi.advanceTimersByTimeAsync(100);
    expect(await accounts()).toEqual([{ login: "smsunarto", active: true }]);

    const stop = harness.behavior.experimental_watchRpc("inbox", { key: "smsunarto" });
    await vi.advanceTimersByTimeAsync(1_000);
    stop();
    const inbox = (await harness.behavior.callRpc("inbox", { keys: ["smsunarto"] })) as Record<
      string,
      { read: { rows: { key: string }[] } | null; problem: unknown }
    >;
    expect(inbox.smsunarto).toMatchObject({
      read: { rows: [{ key: "gh:acme/api:acme:fix/retry" }] },
      problem: null,
    });

    const key = "gh:acme/api:acme:fix/retry";
    const watch = harness.behavior.experimental_watchRpc("changeDetail", { key });
    await vi.advanceTimersByTimeAsync(1_000);
    watch();
    const detail = (
      (await harness.behavior.callRpc("changeDetail", { keys: [key] })) as Record<string, any>
    )[key];
    expect(detail.revision).toEqual({
      head: "beef01",
      base: "main",
      source: { kind: "forge", number: 77 },
    });
    expect(
      await harness.behavior.callRpc("changeFiles", { key, revision: detail.revision }),
    ).toMatchObject({ ok: true, files: [{ path: "src/retry.ts" }] });
    // The thread's own pull request (route-gh), the inbox, #77, then its files: all on host-a.
    expect(world.hostForge).toEqual(["host-a:pr", "host-a:inbox", "host-a:pr", "host-a:files"]);
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

  test("a host that misses the deadline on a range read moves the Change to the forge's revision at once", async () => {
    const world = twoHosts();
    world.hosts["host-a"]!.workspace = workspace("/Users/scott/bb-plugins", {
      target: { ref: "origin/main", head: "aaa1111", behind: 0, base: null, lastFetched: null },
    });
    world.pullRequests["scott/route-gh"] = [PR];
    const { harness } = await start(world, { hostDeadlineMs: 50 });
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    const key = "gh:smsunarto/bb-plugins:smsunarto:scott/route-gh";
    const detail = async () =>
      ((await harness.behavior.callRpc("changeDetail", { keys: [key] })) as Record<string, any>)[
        key
      ];
    const atHost = (await detail()).revision;
    expect(atHost.source.kind).toBe("host");
    world.hosts["host-a"]!.rangeHung = true;
    expect(await harness.behavior.callRpc("changeFiles", { key, revision: atHost })).toMatchObject({
      ok: false,
      problem: { kind: "host-offline" },
    });
    expect((await detail()).revision).toEqual({
      head: "c0ffee",
      base: "main",
      source: { kind: "forge", number: 482 },
    });
    // The host answers again: its next checkout read brings the Change back to it.
    world.hosts["host-a"]!.rangeHung = false;
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    expect((await detail()).revision.source.kind).toBe("host");
  });
});

describe("review items and drafts", () => {
  const KEY = "gh:smsunarto/bb-plugins:smsunarto:scott/route-gh";

  /** A pull request with one human thread and one SlopCop thread. */
  const REVIEWED = {
    ...PR,
    reviewThreads: {
      nodes: [
        {
          id: "T1",
          path: "src/a.ts",
          line: 12,
          startLine: null,
          originalLine: 12,
          diffSide: "RIGHT",
          isResolved: false,
          isOutdated: false,
          comments: {
            nodes: [
              {
                id: "C1",
                body: "Why not reuse the helper?",
                createdAt: "2026-11-01T00:00:00Z",
                url: "https://github.com/x/1",
                author: { __typename: "User", login: "octo" },
              },
              {
                id: "C2",
                body: "Fair.",
                createdAt: "2026-11-01T01:00:00Z",
                url: "https://github.com/x/2",
                author: { __typename: "User", login: "smsunarto" },
              },
            ],
          },
        },
        {
          id: "T2",
          path: "src/b.ts",
          line: 3,
          startLine: null,
          originalLine: 3,
          diffSide: "RIGHT",
          isResolved: false,
          isOutdated: false,
          comments: {
            nodes: [
              {
                id: "C3",
                body: "**[P2]** Missing await\n<!-- slopcop:rule=r run=1 sha=c0ffee kind=inline -->",
                createdAt: "2026-11-01T00:00:00Z",
                url: null,
                author: { __typename: "Bot", login: "slopcop-dev" },
              },
            ],
          },
        },
      ],
    },
  };

  type Review = {
    items: {
      id: string;
      state: string;
      anchor: { path: string; line: number | null; head: string };
      origin: { kind: string; slopcop?: boolean };
    }[];
    drafts: {
      id: string;
      body: string;
      state: string;
      createdAt: number;
      anchor: { line: number | null; head: string };
    }[];
    selected: string[];
    runs: { threadId: string; state: string; findings: number }[];
    viewer: { login: string; avatarUrl: string | null } | null;
  };
  const reviewOf = async (
    harness: Awaited<ReturnType<typeof start>>["harness"],
    key: string,
  ): Promise<Review> =>
    (
      (await harness.behavior.callRpc("reviewForChange", { keys: [key] })) as Record<string, Review>
    )[key]!;
  const anchor = (path: string, line: number, head = "c0ffee") => ({
    path,
    line,
    startLine: null,
    side: "RIGHT" as const,
    head,
  });

  test("GitHub's review threads come with the pull request read, one item per thread, SlopCop's by its marker", async () => {
    const world = twoHosts();
    world.pullRequests["scott/route-gh"] = [REVIEWED];
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    const review = await reviewOf(harness, KEY);
    expect(review.items.map((item) => [item.id, item.origin])).toEqual([
      ["gh:T1", { kind: "forge", author: "octo", bot: false, slopcop: false }],
      ["gh:T2", { kind: "forge", author: "slopcop-dev", bot: true, slopcop: true }],
    ]);
    expect(review.items[0]).toMatchObject({
      anchor: { path: "src/a.ts", line: 12, head: "c0ffee" },
      replies: [{ id: "C2", author: "smsunarto" }],
    });
    // One GitHub call brought the pull request, its checks and its threads.
    expect(world.ghCalls).toEqual(["scott/route-gh"]);
  });

  test("a draft saved twice with one client id is one draft, on a local Change with no pull request", async () => {
    const world = twoHosts();
    world.hosts["host-a"]!.workspace = workspace("/Users/scott/bb-plugins", { github: null });
    const { harness, checkout, invalidations } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    const key = (await checkout("thread-a")).key!;
    expect(key.startsWith("local:")).toBe(true);
    const draft = { id: "d-1", anchor: anchor("src/a.ts", 4), body: "Rename this.", replyTo: null };
    await harness.behavior.callRpc("saveDraft", { key, draft });
    const published = invalidations().length;
    // A retry after a lost answer changes nothing and tells no one.
    await harness.behavior.callRpc("saveDraft", { key, draft });
    expect(invalidations()).toHaveLength(published);
    await harness.behavior.callRpc("saveDraft", { key, draft: { ...draft, body: "Rename it." } });
    const { drafts } = await reviewOf(harness, key);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ id: "d-1", body: "Rename it.", state: "pending" });
    await harness.behavior.callRpc("deleteDraft", { key, id: "d-1" });
    await harness.behavior.callRpc("deleteDraft", { key, id: "d-1" });
    expect((await reviewOf(harness, key)).drafts).toEqual([]);
  });

  test("drafts and the selection survive a restart and read the same from every client", async () => {
    const world = twoHosts();
    world.pullRequests["scott/route-gh"] = [REVIEWED];
    const { harness, restart } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    await harness.behavior.callRpc("saveDraft", {
      key: KEY,
      draft: { id: "d-1", anchor: anchor("src/a.ts", 12), body: "Agreed.", replyTo: "gh:T1" },
    });
    await harness.behavior.callRpc("setSelected", {
      key: KEY,
      ids: ["gh:T1", "gh:T2"],
      selected: true,
    });
    await harness.behavior.callRpc("setSelected", { key: KEY, ids: ["gh:T2"], selected: false });
    const before = await reviewOf(harness, KEY);
    expect(before.selected).toEqual(["gh:T1"]);
    expect(before.drafts).toMatchObject([{ id: "d-1", replyTo: "gh:T1" }]);
    // A second client asks the server, which holds the only copy.
    expect(await reviewOf(harness, KEY)).toEqual(before);
    expect(before.viewer).toEqual({
      login: "smsunarto",
      avatarUrl: "https://github.com/smsunarto.png?size=48",
    });
    const after = await restart();
    // All of it is stored, "You" included, before GitHub is asked again.
    expect(await reviewOf(after, KEY)).toEqual(before);
  });

  test("a new head moves findings and drafts past the edits above them, outdates the ones whose lines changed, and drops none", async () => {
    const world = twoHosts();
    world.hosts["host-a"]!.workspace = workspace("/Users/scott/bb-plugins", {
      target: { ref: "origin/main", head: "aaa1111", behind: 0, base: null, lastFetched: null },
    });
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    const started = (await harness.behavior.callRpc("startReview", { key: KEY })) as {
      ok: true;
      threadId: string;
    };
    expect(started).toMatchObject({ ok: true, reused: false });
    expect(world.spawned?.[0]).toMatchObject({
      pluginMetadata: { kind: "review", changeKey: KEY, head: "c0ffee" },
      environment: { type: "reuse", environmentId: "env-thread-a" },
    });
    expect(world.spawned?.[0]?.prompt).toContain("git diff aaa1111...c0ffee");
    // Asking again while it runs returns the same review.
    expect(await harness.behavior.callRpc("startReview", { key: KEY })).toMatchObject({
      threadId: started.threadId,
      reused: true,
    });
    const finding = (path: string, line: number) => ({
      priority: 1,
      title: "Fix it",
      body: "",
      path,
      line,
    });
    await harness.behavior.callAgentTool(
      "source_control_report_findings",
      {
        summary: "Two problems in a.ts, one in b.ts.",
        findings: [finding("src/a.ts", 10), finding("src/a.ts", 40), finding("src/b.ts", 5)],
      },
      { threadId: started.threadId },
    );
    await harness.behavior.callRpc("saveDraft", {
      key: KEY,
      draft: { id: "d-1", anchor: anchor("src/a.ts", 40), body: "And here.", replyTo: null },
    });
    let review = await reviewOf(harness, KEY);
    expect(review.items.map((item) => item.id)).toEqual([
      `bb:${started.threadId}:1`,
      `bb:${started.threadId}:2`,
      `bb:${started.threadId}:3`,
    ]);
    expect(review.runs).toMatchObject([{ state: "reported", findings: 3 }]);

    // A commit replaces line 10 of a.ts with two lines and leaves b.ts alone.
    const next = branch({ head: "d00d1e" });
    world.hosts["host-a"]!.workspace = workspace("/Users/scott/bb-plugins", {
      target: { ref: "origin/main", head: "aaa1111", behind: 0, base: null, lastFetched: null },
      stacks: [{ key: next.name, branches: [next], assigned: [] }],
    });
    world.hosts["host-a"]!.patches = {
      "src/a.ts":
        "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,3 +9,4 @@\n ctx\n-old\n+new\n+newer\n ctx\n",
    };
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    await vi.waitFor(async () => {
      review = await reviewOf(harness, KEY);
      expect(review.items[1]?.anchor.head).toBe("d00d1e");
    });
    expect(review.items.map((item) => [item.state, item.anchor.line, item.anchor.head])).toEqual([
      ["outdated", 10, "c0ffee"],
      ["open", 41, "d00d1e"],
      ["open", 5, "d00d1e"],
    ]);
    expect(review.drafts.map((draft) => [draft.state, draft.anchor.line])).toEqual([
      ["pending", 41],
    ]);
  });

  test("bb gives a plugin one command: import while code-review runs, bb review once it is gone", async () => {
    const before = { ...twoHosts(), codeReviewRunning: true };
    const old = (await start(before)).harness;
    await vi.waitFor(() => expect(old.inspection.registrations.cli?.name).toBe("source-control"));
    const after = (await start(twoHosts())).harness;
    await vi.waitFor(() => expect(after.inspection.registrations.cli?.name).toBe("review"));
    const prompt = await after.behavior.runCli(["prompt", "--request", "Intent: test"]);
    expect(prompt.exitCode).toBe(0);
  });

  test("only review threads get the findings tool, and a thread that is not one cannot report", async () => {
    const world = twoHosts();
    const { harness } = await start(world);
    const tools = async (pluginMetadata: Record<string, string>) =>
      (
        await harness.behavior.resolveAgentConfiguration(
          makePluginAgentConfigurationContext({ pluginMetadata }),
        )
      ).tools.map((tool) => tool.name);
    expect(await tools({ kind: "review", changeKey: KEY })).toEqual([
      "source_control_report_findings",
      "source_control_share_change",
    ]);
    // An author thread, once code-review is gone, also watches and lands its pull requests.
    expect(await tools({})).toEqual([
      "source_control_share_change",
      "source_control_watch_pr",
      "source_control_share_landed",
    ]);
    await expect(
      harness.behavior.callAgentTool(
        "source_control_report_findings",
        { summary: "", findings: [] },
        { threadId: "thread-a" },
      ),
    ).rejects.toThrow(/not a Source Control review/);
  });

  test("an idle change with review threads stays within 5 gh runs a minute while its page and tab watch, and none once hidden", async () => {
    vi.useFakeTimers();
    const world = twoHosts();
    world.pullRequests["scott/route-gh"] = [REVIEWED];
    const { harness } = await start(world);
    const watches = [
      harness.behavior.experimental_watchRpc("changeForThread", { key: "thread-a" }),
      harness.behavior.experimental_watchRpc("changeDetail", { key: KEY }),
      harness.behavior.experimental_watchRpc("reviewForChange", { key: KEY }),
    ];
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    for (const stop of watches) stop();
    const runs = world.ghRuns ?? [];
    const busiest = Math.max(
      ...runs.map((at) => runs.filter((other) => other >= at && other < at + 60_000).length),
    );
    expect(busiest).toBeLessThanOrEqual(5);
    const seen = runs.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(world.ghRuns ?? []).toHaveLength(seen);
  });

  describe("sending", () => {
    type View = {
      id: string;
      state: string;
      phase: string;
      problem: { kind: string; detail?: string } | null;
      threadId: string | null;
      url: string | null;
    };
    const REVIEWS = "repos/smsunarto/bb-plugins/pulls/482/reviews";
    const toAgent = (id: string, itemIds = ["gh:T1"], draftIds: string[] = []) => ({
      id,
      head: "c0ffee",
      itemIds,
      draftIds,
      destination: "agent" as const,
      target: { kind: "thread" as const, threadId: "thread-a" },
    });
    const toGitHub = (id: string, draftIds: string[]) => ({
      id,
      head: "c0ffee",
      itemIds: [],
      draftIds,
      destination: "github" as const,
      target: { kind: "pull-request" as const, number: 482 },
    });
    const send = (harness: Awaited<ReturnType<typeof start>>["harness"], batch: unknown) =>
      harness.behavior.callRpc("sendBatch", { key: KEY, batch }) as Promise<View>;
    const reviewed = async (world: World = twoHosts()) => {
      world.pullRequests["scott/route-gh"] = [REVIEWED];
      const started = await start(world);
      await started.harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
      return { world, ...started };
    };
    const draft = (harness: Awaited<ReturnType<typeof start>>["harness"], id: string) =>
      harness.behavior.callRpc("saveDraft", {
        key: KEY,
        draft: { id, anchor: anchor("src/a.ts", 12), body: "Use the helper here.", replyTo: null },
      });

    test("two sends with one id reach the agent once, with ids, anchors, bodies, revision and the marker", async () => {
      const { world, harness } = await reviewed();
      await harness.behavior.callRpc("setSelected", { key: KEY, ids: ["gh:T1"], selected: true });
      const [first, second] = await Promise.all([
        send(harness, toAgent("b-1")),
        send(harness, toAgent("b-1")),
      ]);
      expect(first).toMatchObject({ state: "sent", threadId: "thread-a" });
      expect(second).toMatchObject({ state: "sent", threadId: "thread-a" });
      expect(world.messages?.["thread-a"]).toHaveLength(1);
      const text = world.messages!["thread-a"]![0]!;
      expect(text).toContain("gh:T1");
      expect(text).toContain("src/a.ts:12");
      expect(text).toContain("Why not reuse the helper?");
      expect(text).toContain("c0ffee");
      expect(text).toContain("<!-- source-control:batch=b-1 -->");
      expect(text).not.toContain("diff --git");
      // The test checkout's base is its target commit, named as such.
      expect(text).not.toContain("`branch:");
      // A third send with the id is answered from the store.
      expect(await send(harness, toAgent("b-1"))).toMatchObject({ state: "sent" });
      expect(world.messages!["thread-a"]).toHaveLength(1);
      // Sent items leave the selection.
      expect((await reviewOf(harness, KEY)).selected).toEqual([]);
    });

    test("a send whose answer was lost, retried after a restart, finds its marker and sends nothing", async () => {
      const { world, harness, restart } = await reviewed();
      world.sendAs = ["lost"];
      const lost = await send(harness, toAgent("b-2"));
      expect(lost).toMatchObject({ state: "queued", problem: { kind: "failed" } });
      expect(world.messages?.["thread-a"]).toHaveLength(1);
      const after = await restart();
      expect(await send(after, toAgent("b-2"))).toMatchObject({ state: "sent" });
      expect(world.messages!["thread-a"]).toHaveLength(1);
    });

    test("a send cut off mid-call by a restart is found by its marker, not sent again", async () => {
      const { world, harness, restart } = await reviewed();
      world.sendAs = ["hang"];
      void send(harness, toAgent("b-3")).catch(() => undefined);
      await vi.waitFor(() => expect(world.messages?.["thread-a"]).toHaveLength(1));
      // Unloading waits its 5 s grace for the call, then interrupts it.
      const after = await restart();
      const review = (await after.behavior.callRpc("reviewForChange", { keys: [KEY] })) as Record<
        string,
        { batches: View[] }
      >;
      expect(review[KEY]!.batches[0]).toMatchObject({ id: "b-3", state: "sending" });
      expect(await send(after, toAgent("b-3"))).toMatchObject({ state: "sent" });
      expect(world.messages!["thread-a"]).toHaveLength(1);
    }, 15_000);

    test("a refused send stays queued with its problem until an explicit retry sends it", async () => {
      const { world, harness } = await reviewed();
      world.sendAs = ["refuse"];
      expect(await send(harness, toAgent("b-4"))).toMatchObject({
        state: "queued",
        problem: { kind: "failed", detail: "Thread is not reachable" },
      });
      expect(world.messages?.["thread-a"]).toBeUndefined();
      expect(await send(harness, toAgent("b-4"))).toMatchObject({ state: "sent" });
      expect(world.messages!["thread-a"]).toHaveLength(1);
    });

    test("two GitHub submits with one id post one review pinned to the head, and the drafts go only once it is sent", async () => {
      const { world, harness } = await reviewed();
      await draft(harness, "d-1");
      const [first, second] = await Promise.all([
        send(harness, toGitHub("g-1", ["d-1"])),
        send(harness, toGitHub("g-1", ["d-1"])),
      ]);
      expect(first).toMatchObject({ state: "sent", phase: "posted" });
      expect(second).toMatchObject({ state: "sent" });
      expect(world.reviews?.[REVIEWS]).toHaveLength(1);
      expect(world.reviews![REVIEWS]![0]).toMatchObject({
        commit_id: "c0ffee",
        comments: [{ path: "src/a.ts", line: 12, side: "RIGHT", body: "Use the helper here." }],
      });
      expect(world.reviews![REVIEWS]![0]!.body).toContain("<!-- source-control:batch=g-1 -->");
      expect((await reviewOf(harness, KEY)).drafts).toEqual([]);
    });

    test("a GitHub submit whose answer was lost, retried after a restart, finds its review and posts nothing", async () => {
      const { world, harness, restart } = await reviewed();
      await draft(harness, "d-1");
      world.postAs = ["lost"];
      expect(await send(harness, toGitHub("g-2", ["d-1"]))).toMatchObject({ state: "queued" });
      expect(world.reviews![REVIEWS]).toHaveLength(1);
      // Not sent, so the draft is still there.
      expect((await reviewOf(harness, KEY)).drafts).toHaveLength(1);
      const after = await restart();
      expect(await send(after, toGitHub("g-2", ["d-1"]))).toMatchObject({
        state: "sent",
        url: `https://github.com/${REVIEWS}#1`,
      });
      expect(world.reviews![REVIEWS]).toHaveLength(1);
      expect((await reviewOf(after, KEY)).drafts).toEqual([]);
    });

    test("a pull request that moved since the reader looked takes no review, and the batch fails saying so", async () => {
      const { world, harness } = await reviewed();
      await draft(harness, "d-1");
      world.pullRequests["scott/route-gh"] = [{ ...REVIEWED, headRefOid: "d00d1e" }];
      expect(await send(harness, toGitHub("g-3", ["d-1"]))).toMatchObject({
        state: "failed",
        problem: { kind: "moved", detail: expect.stringContaining("d00d1e") },
      });
      expect(world.reviews?.[REVIEWS] ?? []).toEqual([]);
      expect((await reviewOf(harness, KEY)).drafts).toHaveLength(1);
    });

    test("with no GitHub site the batch stays queued, naming the problem", async () => {
      const world = twoHosts();
      world.serverAccounts = [];
      const { harness } = await start(world);
      await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
      await draft(harness, "d-1");
      const queued = await send(harness, toGitHub("g-4", ["d-1"]));
      expect(queued.state).toBe("queued");
      expect(["no-site", "auth"]).toContain(queued.problem?.kind);
      expect(world.reviews?.[REVIEWS] ?? []).toEqual([]);
    });

    test("an offline host leaves a new-thread batch queued with the reason", async () => {
      const { world, harness } = await reviewed();
      world.hosts["host-a"]!.online = false;
      world.hosts["host-b"]!.online = false;
      world.sendAs = ["refuse"];
      const queued = await send(harness, {
        ...toAgent("b-5"),
        target: { kind: "thread", threadId: "thread-a" },
      });
      expect(queued).toMatchObject({ state: "queued", problem: { kind: "failed" } });
      expect(world.messages?.["thread-a"]).toBeUndefined();
    });

    test("a sent batch shows fixing while its thread runs, verify after a new head once idle, and Stop stops it", async () => {
      const { world, harness } = await reviewed();
      const sent = await send(harness, toAgent("b-6"));
      expect(sent.phase).toBe("fixing");
      const batches = async () =>
        (
          (await harness.behavior.callRpc("reviewForChange", { keys: [KEY] })) as Record<
            string,
            { batches: View[] }
          >
        )[KEY]!.batches;
      await harness.behavior.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: "thread-a" }),
      } as never);
      await vi.waitFor(async () => expect((await batches())[0]!.phase).toBe("stopped"));
      world.hosts["host-a"]!.workspace = workspace("/Users/scott/bb-plugins", {
        stacks: [{ key: "scott/route-gh", branches: [branch({ head: "d00d1e" })], assigned: [] }],
      });
      await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
      await vi.waitFor(async () => expect((await batches())[0]!.phase).toBe("verify"));
      expect(await harness.behavior.callRpc("stopAgent", { key: KEY, batchId: "b-6" })).toEqual({
        ok: true,
      });
      expect(world.stopped).toEqual(["thread-a"]);
    });

    test("a dismissed finding leaves the items, the count and the selection, and dismissing twice is once", async () => {
      const { harness } = await reviewed();
      await harness.behavior.callRpc("setSelected", { key: KEY, ids: ["gh:T2"], selected: true });
      for (let attempt = 0; attempt < 2; attempt += 1)
        expect(await harness.behavior.callRpc("dismissItem", { key: KEY, id: "gh:T2" })).toEqual({
          ok: true,
        });
      const review = await reviewOf(harness, KEY);
      expect(review.items.map((item) => item.id)).toEqual(["gh:T1"]);
      expect(review.selected).toEqual([]);
    });

    test("the tray's destination and target are the server's, so a reload shows the same", async () => {
      const { harness, restart } = await reviewed();
      const tray = { destination: "github", target: { kind: "pull-request", number: 482 } };
      await harness.behavior.callRpc("setTray", { key: KEY, tray });
      const after = await restart();
      expect(
        (
          (await after.behavior.callRpc("reviewForChange", { keys: [KEY] })) as Record<
            string,
            { tray: unknown }
          >
        )[KEY]!.tray,
      ).toEqual(tray);
    });

    test("share_change returns the thread's Change and head as a directive and nothing else", async () => {
      const { harness } = await reviewed();
      expect(
        await harness.behavior.callAgentTool(
          "source_control_share_change",
          {},
          { threadId: "thread-a" },
        ),
      ).toBe(`::source-control{key="${encodeURIComponent(KEY)}" revision="c0ffee"}`);
    });
  });
});

describe("guided diff", () => {
  const blob = (tag: string) => tag.repeat(40);
  const file = (path: string, tag: string) => ({
    path,
    kind: "modified",
    previousPath: null,
    additions: 2,
    deletions: 1,
    binary: false,
    blob: blob(tag),
  });
  const keyOf = (n: number) => `gh:smsunarto/bb-plugins:smsunarto:scott/g${n}`;

  /** `count` hosts, each with one thread on its own branch `scott/g<n>`, so `count` Changes. */
  function changes(count: number): World {
    const world: World = { ...twoHosts(), hosts: {}, threads: {} };
    for (let n = 1; n <= count; n++) {
      const path = `/srv/h${n}/bb-plugins`;
      const only = branch({
        name: `scott/g${n}`,
        remote: { ref: `origin/scott/g${n}`, name: `scott/g${n}` },
      });
      world.hosts[`h${n}`] = {
        name: `host-${n}`,
        online: true,
        workspace: workspace(path, {
          checkedOut: only.name,
          stacks: [{ key: only.name, branches: [only], assigned: [] }],
        }),
        ghAccounts: [],
        files: [file("src/a.ts", "a"), file("src/b.ts", "b")],
      };
      world.threads[`t${n}`] = { hostId: `h${n}`, path };
    }
    return world;
  }

  async function opened(count: number) {
    const world = changes(count);
    const started = await start(world);
    for (let n = 1; n <= count; n++)
      await started.harness.behavior.callRpc("refreshThread", { threadId: `t${n}` });
    return { world, ...started };
  }

  type Harness = Awaited<ReturnType<typeof start>>["harness"];
  const guideOf = async (harness: Harness, key: string) =>
    (
      (await harness.behavior.callRpc("guideForChange", { keys: [key] })) as Record<
        string,
        GuideView
      >
    )[key]!;
  const write = (
    harness: Harness,
    threadId: string,
    groups: { title: string; files: string[] }[],
  ) =>
    harness.behavior.callAgentTool(
      "source_control_write_guide",
      {
        summary: "Read the client, then its tests.",
        groups: groups.map((group) => ({
          title: group.title,
          intro: `Why ${group.title} matters.`,
          files: group.files.map((path) => ({ path })),
        })),
      },
      { threadId },
    );

  test("reads from every other surface start no run; two opens at once start one hidden run", async () => {
    const { world, harness } = await opened(1);
    const key = keyOf(1);
    await harness.behavior.callRpc("guideForChange", { keys: [key] });
    await harness.behavior.callRpc("changeDetail", { keys: [key] });
    await harness.behavior.callRpc("reviewForChange", { keys: [key] });
    await harness.behavior.callRpc("changeForThread", { keys: ["t1"] });
    await harness.behavior.callRpc("statusForThread", { keys: ["t1"] });
    expect(await guideOf(harness, key)).toMatchObject({ state: "none", phase: "none" });
    expect(world.spawned ?? []).toEqual([]);

    const [one, two] = (await Promise.all([
      harness.behavior.callRpc("openGuide", { key }),
      harness.behavior.callRpc("openGuide", { key }),
    ])) as GuideView[];
    expect([one!.state, two!.state]).toEqual(["running", "running"]);
    await vi.waitFor(() => expect(world.spawned).toHaveLength(1));
    await harness.behavior.callRpc("openGuide", { key });
    expect(world.spawned).toHaveLength(1);
    const run = world.spawned![0]!;
    expect(run).toMatchObject({
      visibility: "hidden",
      pluginMetadata: { kind: "guide", changeKey: key, revision: "c0ffee" },
      environment: { type: "reuse", environmentId: "env-t1" },
    });
    // The file list with stats; the agent reads the diff itself.
    expect(run.prompt).toContain("`src/a.ts` (modified, +2 −1)");
    expect(run.prompt).toContain("git diff aaa111...c0ffee");
    expect(run.prompt).not.toContain("@@");
    expect(await guideOf(harness, key)).toMatchObject({
      state: "running",
      phase: "writing",
      threadId: run.id,
      revision: "c0ffee",
    });
  });

  test("three Changes opened at once: two run, the third waits in order until a slot frees", async () => {
    const { world, harness } = await opened(3);
    for (const n of [1, 2, 3]) await harness.behavior.callRpc("openGuide", { key: keyOf(n) });
    await vi.waitFor(() => expect(world.spawned).toHaveLength(2));
    expect(
      world.spawned!.map((run) => (run.pluginMetadata as { changeKey: string }).changeKey),
    ).toEqual([keyOf(1), keyOf(2)]);
    expect(await guideOf(harness, keyOf(3))).toMatchObject({ state: "running", phase: "waiting" });
    await write(harness, world.spawned![0]!.id, [
      { title: "All", files: ["src/a.ts", "src/b.ts"] },
    ]);
    await vi.waitFor(() => expect(world.spawned).toHaveLength(3));
    expect(await guideOf(harness, keyOf(3))).toMatchObject({ phase: "writing" });
  });

  test("a run that stops without a guide fails; after a restart it fails on the next read, and Try again starts one", async () => {
    const { world, harness, restart } = await opened(2);
    await harness.behavior.callRpc("openGuide", { key: keyOf(1) });
    await harness.behavior.callRpc("openGuide", { key: keyOf(2) });
    await vi.waitFor(() => expect(world.spawned).toHaveLength(2));
    // Idle without writing, while the server runs.
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: world.spawned![0]!.id }),
    } as never);
    expect(await guideOf(harness, keyOf(1))).toMatchObject({
      state: "failed",
      problem: { detail: "The guide run ended without writing a guide." },
    });

    // The server restarts while the second runs, and the run stops meanwhile.
    world.idle = [world.spawned![1]!.id];
    const after = await restart();
    await vi.waitFor(async () =>
      expect(await guideOf(after, keyOf(2))).toMatchObject({ state: "failed", phase: "failed" }),
    );
    expect(world.spawned).toHaveLength(2);
    // Opening again does not retry; Try again does, once.
    await after.behavior.callRpc("openGuide", { key: keyOf(2) });
    expect(world.spawned).toHaveLength(2);
    await Promise.all([
      after.behavior.callRpc("rewriteGuide", { key: keyOf(2) }),
      after.behavior.callRpc("rewriteGuide", { key: keyOf(2) }),
    ]);
    await vi.waitFor(() => expect(world.spawned).toHaveLength(3));
    expect(await guideOf(after, keyOf(2))).toMatchObject({ phase: "writing", problem: null });
  });

  test("only guide runs get the guide tool; it refuses other threads and unknown paths, and a second call replaces the first", async () => {
    const { world, harness } = await opened(1);
    const tools = async (pluginMetadata: Record<string, string>) =>
      (
        await harness.behavior.resolveAgentConfiguration(
          makePluginAgentConfigurationContext({ pluginMetadata }),
        )
      ).tools.map((tool) => tool.name);
    expect(await tools({ kind: "guide", changeKey: keyOf(1) })).toEqual([
      "source_control_write_guide",
      "source_control_share_change",
    ]);
    expect(await tools({ kind: "review", changeKey: keyOf(1) })).not.toContain(
      "source_control_write_guide",
    );
    // An author thread, once code-review is gone, also watches and lands its pull requests.
    expect(await tools({})).toEqual([
      "source_control_share_change",
      "source_control_watch_pr",
      "source_control_share_landed",
    ]);
    await expect(write(harness, "t1", [{ title: "All", files: ["src/a.ts"] }])).rejects.toThrow(
      /not a Source Control guide run/,
    );

    await harness.behavior.callRpc("openGuide", { key: keyOf(1) });
    await vi.waitFor(() => expect(world.spawned).toHaveLength(1));
    const run = world.spawned![0]!.id;
    await expect(
      write(harness, run, [{ title: "All", files: ["src/a.ts", "src/nope.ts"] }]),
    ).rejects.toThrow(/not in the change: src\/nope\.ts/);
    expect(await guideOf(harness, keyOf(1))).toMatchObject({ state: "running", guide: null });

    await write(harness, run, [{ title: "Everything", files: ["src/b.ts", "src/a.ts"] }]);
    await write(harness, run, [
      { title: "Client", files: ["src/a.ts"] },
      { title: "Host", files: ["src/b.ts"] },
    ]);
    const view = await guideOf(harness, keyOf(1));
    expect(view).toMatchObject({ state: "done", phase: "done", revision: "c0ffee" });
    expect(view.guide!.groups.map((group) => [group.title, group.files])).toEqual([
      ["Client", [{ path: "src/a.ts", blob: blob("a"), note: null }]],
      ["Host", [{ path: "src/b.ts", blob: blob("b"), note: null }]],
    ]);
  });

  test("a run is given the head the checkout has now, not the last one stored", async () => {
    const { world, harness } = await opened(1);
    // The branch moved since the server last read it, and nothing has read it again.
    const host = world.hosts.h1!;
    const next = branch({
      name: "scott/g1",
      head: "d00d1e",
      remote: { ref: "origin/scott/g1", name: "scott/g1" },
    });
    host.workspace = {
      ...host.workspace,
      stacks: [{ key: next.name, branches: [next], assigned: [] }],
    };
    await harness.behavior.callRpc("openGuide", { key: keyOf(1) });
    await vi.waitFor(() => expect(world.spawned).toHaveLength(1));
    expect(world.spawned![0]!.pluginMetadata).toMatchObject({ revision: "d00d1e" });
    expect(await guideOf(harness, keyOf(1))).toMatchObject({ revision: "d00d1e" });
  });

  test("with its host away and no pull request, a checkout's Change keeps its last revision, files, guide and marks", async () => {
    const { world, harness } = await opened(1);
    const key = keyOf(1);
    const detailOf = async () =>
      (
        (await harness.behavior.callRpc("changeDetail", { keys: [key] })) as Record<
          string,
          { revision: ReviewRevision | null; problem: unknown }
        >
      )[key]!;
    const before = await detailOf();
    await harness.behavior.callRpc("changeFiles", { key, revision: before.revision });
    await harness.behavior.callRpc("openGuide", { key });
    await vi.waitFor(() => expect(world.spawned).toHaveLength(1));
    await write(harness, world.spawned![0]!.id, [
      { title: "All", files: ["src/a.ts", "src/b.ts"] },
    ]);
    await harness.behavior.callRpc("setViewed", {
      key,
      path: "src/a.ts",
      blob: blob("a"),
      viewed: true,
    });

    world.hosts.h1!.online = false;
    await harness.behavior.callRpc("refreshThread", { threadId: "t1" });
    const after = await detailOf();
    expect(after.problem).toMatchObject({ kind: "host-offline" });
    expect(after.revision).toEqual(before.revision);
    expect(
      await harness.behavior.callRpc("changeFiles", { key, revision: after.revision }),
    ).toMatchObject({ ok: true, files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] });
    expect(await guideOf(harness, key)).toMatchObject({
      state: "done",
      viewed: [{ path: "src/a.ts", blob: blob("a") }],
    });
  });

  test("a Change no run can start for says why and holds no slot", async () => {
    const world = changes(1);
    world.pullRequests["fix/retry"] = [INBOX_PR];
    world.rest = {
      "repos/acme/api/pulls/77/files?per_page=100": [
        [
          {
            filename: "src/retry.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            sha: blob("e"),
          },
        ],
      ],
    };
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "t1" });
    const forgeOnly = "gh:acme/api:acme:fix/retry";
    const stop = harness.behavior.experimental_watchRpc("changeDetail", { key: forgeOnly });
    await vi.waitFor(async () =>
      expect(
        (
          (await harness.behavior.callRpc("changeDetail", { keys: [forgeOnly] })) as Record<
            string,
            { state: string }
          >
        )[forgeOnly],
      ).toMatchObject({ state: "change" }),
    );
    stop();
    await harness.behavior.callRpc("openGuide", { key: forgeOnly });
    await harness.behavior.callRpc("openGuide", { key: keyOf(1) });
    await vi.waitFor(async () =>
      expect(await guideOf(harness, forgeOnly)).toMatchObject({
        state: "failed",
        problem: { detail: "Add acme/api as a bb project first." },
      }),
    );
    await vi.waitFor(() => expect(world.spawned).toHaveLength(1));
    // Viewed marks need no run and no checkout.
    await harness.behavior.callRpc("setViewed", {
      key: forgeOnly,
      path: "src/retry.ts",
      blob: blob("e"),
      viewed: true,
    });
    expect((await guideOf(harness, forgeOnly)).viewed).toEqual([
      { path: "src/retry.ts", blob: blob("e") },
    ]);
  });

  test("a new head starts no run: unchanged files keep their group and viewed mark, changed ones regroup", async () => {
    const { world, harness } = await opened(1);
    const key = keyOf(1);
    await harness.behavior.callRpc("openGuide", { key });
    await vi.waitFor(() => expect(world.spawned).toHaveLength(1));
    await write(harness, world.spawned![0]!.id, [
      { title: "Client", files: ["src/a.ts"] },
      { title: "Host", files: ["src/b.ts"] },
    ]);
    for (const tag of ["a", "b"]) {
      const path = `src/${tag}.ts`;
      await harness.behavior.callRpc("setViewed", { key, path, blob: blob(tag), viewed: true });
      // Convergent: a retry changes nothing.
      await harness.behavior.callRpc("setViewed", { key, path, blob: blob(tag), viewed: true });
    }
    expect((await guideOf(harness, key)).viewed).toHaveLength(2);

    // A commit changes a.ts and adds c.ts.
    const host = world.hosts.h1!;
    const next = branch({
      name: "scott/g1",
      head: "d00d1e",
      remote: { ref: "origin/scott/g1", name: "scott/g1" },
    });
    host.workspace = {
      ...host.workspace,
      stacks: [{ key: next.name, branches: [next], assigned: [] }],
    };
    host.files = [file("src/a.ts", "c"), file("src/b.ts", "b"), file("src/c.ts", "d")];
    await harness.behavior.callRpc("refreshThread", { threadId: "t1" });
    const detail = (
      (await harness.behavior.callRpc("changeDetail", { keys: [key] })) as Record<
        string,
        { revision: ReviewRevision }
      >
    )[key]!;
    expect(detail.revision.head).toBe("d00d1e");
    await harness.behavior.callRpc("openGuide", { key });
    expect(world.spawned).toHaveLength(1);

    const listed = (await harness.behavior.callRpc("changeFiles", {
      key,
      revision: detail.revision,
    })) as { ok: true; files: ChangeFile[] };
    const view = await guideOf(harness, key);
    const resolved = resolveGuide(view.guide, listed.files, detail.revision.head);
    expect(resolved.source).toBe("carried");
    expect(resolved.groups.map((group) => [group.title, group.files.map((f) => f.path)])).toEqual([
      ["Host", ["src/b.ts"]],
      ["Changed since the guide", ["src/a.ts", "src/c.ts"]],
    ]);
    expect([...viewedAtHead(listed.files, view.viewed)]).toEqual(["src/b.ts"]);
  });
});

test("the Change's detail and its thread's row derive one status: pushed with no pull request, then ahead", async () => {
  const { changeState, summarize } = await import("../core/status.ts");
  const world = twoHosts();
  const { harness, read } = await start(world);
  const key = "gh:smsunarto/bb-plugins:smsunarto:scott/route-gh";
  const both = async () => {
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    const detail = (
      (await harness.behavior.callRpc("changeDetail", { keys: [key] })) as Record<
        string,
        { status: unknown }
      >
    )[key]!;
    return { card: detail.status, strip: changeState(summarize(await read("thread-a"))!) };
  };
  let seen = await both();
  expect(seen.card).toEqual(seen.strip);
  expect(seen.card).toMatchObject({ label: "Pushed", noPullRequest: true });
  world.hosts["host-a"]!.workspace = workspace("/Users/scott/bb-plugins", {
    stacks: [
      {
        key: "scott/route-gh",
        branches: [branch({ status: "ahead", push: "push", ahead: 1 })],
        assigned: [],
      },
    ],
  });
  seen = await both();
  expect(seen.card).toEqual(seen.strip);
  expect(seen.card).toMatchObject({ label: "Unpushed" });
});

describe("ask agent", () => {
  const KEY = "gh:smsunarto/bb-plugins:smsunarto:scott/route-gh";
  type Harness = Awaited<ReturnType<typeof start>>["harness"];
  const askOf = async (harness: Harness, key: string) =>
    ((await harness.behavior.callRpc("askForChange", { keys: [key] })) as Record<string, any>)[key]!
      .threadId as string | null;

  /** One thread on `scott/route-gh`, read once: the Change's owning thread. */
  async function owned() {
    const world = twoHosts();
    delete world.threads["thread-b"];
    const started = await start(world);
    await started.harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    return { world, ...started };
  }

  test("opening and reading create nothing; two first questions at once fork the owner once, hidden, told the Change", async () => {
    const { world, harness } = await owned();
    expect(await askOf(harness, KEY)).toBeNull();
    expect(world.forked ?? []).toEqual([]);

    const [one, two] = (await Promise.all([
      harness.behavior.callRpc("ask", { key: KEY, text: "Why is the account in the key?" }),
      harness.behavior.callRpc("ask", { key: KEY, text: "And the timeout?" }),
    ])) as { ok: true; threadId: string }[];
    expect(world.forked).toHaveLength(1);
    expect(one).toEqual({ ok: true, threadId: "ask-1" });
    expect(two).toEqual({ ok: true, threadId: "ask-1" });
    const fork = world.forked![0]! as Record<string, any>;
    expect(fork).toMatchObject({
      sourceThreadId: "thread-a",
      visibility: "hidden",
      permissionMode: "auto",
      pluginMetadata: { kind: "ask", changeKey: KEY },
      input: [{ type: "text", text: "Why is the account in the key?" }],
    });
    const seed = fork.agentContextSeed[0];
    expect(seed.visibility).toBe("agent-only");
    expect(seed.text).toContain("Head: `c0ffee`");
    expect(seed.text).toContain("/Users/scott/bb-plugins");
    expect(seed.text).toContain("git diff aaa111...c0ffee");
    // The second waited for the fork, then went to the same thread.
    expect(world.messages?.["ask-1"]).toEqual(["And the timeout?"]);
    expect(await askOf(harness, KEY)).toBe("ask-1");
  });

  test("reopening reuses the Ask thread, from a line too, after a restart; Open as full thread unhides it", async () => {
    const { world, harness, restart } = await owned();
    await harness.behavior.callRpc("ask", { key: KEY, text: "First?" });
    const after = await restart();
    // Another client, or the same page after a restart, finds the stored thread.
    expect(await askOf(after, KEY)).toBe("ask-1");
    expect(
      await after.behavior.callRpc("ask", {
        key: KEY,
        text: "Why optional?",
        path: "src/host/client.ts",
        line: 42,
      }),
    ).toEqual({ ok: true, threadId: "ask-1" });
    expect(world.forked).toHaveLength(1);
    expect(world.messages?.["ask-1"]).toEqual(["About `src/host/client.ts:42`:\n\nWhy optional?"]);

    expect(await after.behavior.callRpc("openAskAsThread", { key: KEY })).toEqual({
      ok: true,
      threadId: "ask-1",
    });
    expect(world.updated).toEqual([{ threadId: "ask-1", visibility: "visible" }]);
  });

  test("a first question from a line names it in the forked thread's message", async () => {
    const { world, harness } = await owned();
    await harness.behavior.callRpc("ask", {
      key: KEY,
      text: "Is this right?",
      path: "src/a.ts",
      line: 7,
    });
    expect((world.forked![0] as Record<string, any>).input[0].text).toBe(
      "About `src/a.ts:7`:\n\nIs this right?",
    );
  });

  test("with several threads on the Change, the first question starts a hidden thread in its project instead of forking", async () => {
    const world = twoHosts();
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-b" });
    expect(await harness.behavior.callRpc("ask", { key: KEY, text: "Which one?" })).toMatchObject({
      ok: true,
    });
    expect(world.forked ?? []).toEqual([]);
    expect(world.spawned).toHaveLength(1);
    expect(world.spawned![0]).toMatchObject({
      visibility: "hidden",
      permissionMode: "auto",
      pluginMetadata: { kind: "ask", changeKey: KEY },
      environment: { type: "reuse" },
    });
    const parts = (
      world.spawned![0] as unknown as { input: { text: string; visibility?: string }[] }
    ).input;
    expect(parts.map((part) => part.visibility ?? "visible")).toEqual(["agent-only", "visible"]);
    expect(parts[1]!.text).toBe("Which one?");
  });

  test("a pull request with no checkout gets a hidden thread in a new worktree of its project", async () => {
    vi.useFakeTimers();
    const world = twoHosts();
    world.pullRequests["fix/retry"] = [INBOX_PR];
    world.rest = { "repos/acme/api/pulls/77/files?per_page=100": [[]] };
    world.projects = [
      {
        id: "proj-acme",
        gitRemoteUrl: "https://github.com/acme/api.git",
        sources: [{ hostId: "host-b", isDefault: true }],
      },
    ];
    const { harness } = await start(world);
    const key = "gh:acme/api:acme:fix/retry";
    const stop = harness.behavior.experimental_watchRpc("changeDetail", { key });
    await vi.advanceTimersByTimeAsync(1_000);
    const asked = harness.behavior.callRpc("ask", { key, text: "What does it retry?" });
    await vi.advanceTimersByTimeAsync(10);
    expect(await asked).toMatchObject({ ok: true });
    stop();
    expect(world.forked ?? []).toEqual([]);
    expect(world.spawned![0]).toMatchObject({
      projectId: "proj-acme",
      visibility: "hidden",
      environment: { type: "host", hostId: "host-b", workspace: { type: "managed-worktree" } },
    });
    const [seed] = (world.spawned![0] as unknown as { input: { text: string }[] }).input;
    expect(seed!.text).toContain("Pull request: #77");
  });

  test("Ask agent to fix on a checkout without but starts a visible thread on that host with the install prompt", async () => {
    const world = twoHosts();
    world.hosts["host-b"]!.failure = {
      code: "but-missing",
      message: "but: command not found",
    };
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-b" });
    expect(await harness.behavior.callRpc("askToFix", { threadId: "thread-a" })).toEqual({
      ok: false,
      message: "No tool is missing from this checkout.",
    });
    expect(await harness.behavior.callRpc("askToFix", { threadId: "thread-b" })).toMatchObject({
      ok: true,
    });
    expect(world.spawned).toHaveLength(1);
    const run = world.spawned![0]!;
    expect(run).toMatchObject({
      visibility: "visible",
      environment: { type: "reuse", environmentId: "env-thread-b" },
      pluginMetadata: { kind: "install", tool: "but", hostId: "host-b" },
    });
    expect(run.prompt).toContain("`but` is not installed here");
    expect(run.prompt).toContain("but: command not found");
    expect(run.prompt).toContain("/home/scott/bb-plugins");
  });
});

describe("create PR", () => {
  test("Create PR starts one visible child with the checkout's own prompt, pinned to the head seen", async () => {
    const world = twoHosts();
    world.hosts["host-b"]!.workspace = workspace("/home/scott/bb-plugins", {
      provider: "gitbutler",
    });
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-b" });
    const head = branch().head!;

    expect(
      await harness.behavior.callRpc("createPullRequest", {
        threadId: "thread-a",
        branch: "scott/route-gh",
        head: "0ld0ld",
      }),
    ).toEqual({
      ok: false,
      message: "The branch changed since you looked. Review it and try again.",
    });
    expect(world.spawned ?? []).toHaveLength(0);

    const git = await harness.behavior.callRpc("createPullRequest", {
      threadId: "thread-a",
      branch: "scott/route-gh",
      head,
    });
    expect(git).toMatchObject({ ok: true });
    expect(world.spawned).toHaveLength(1);
    expect(world.spawned![0]).toMatchObject({
      visibility: "visible",
      parentThreadId: "thread-a",
      title: "Create PR for scott/route-gh",
      environment: { type: "reuse", environmentId: "env-thread-a" },
    });
    expect(world.spawned![0]!.prompt).toContain("ordinary Git checkout");
    expect(world.spawned![0]!.prompt).toContain(
      "git config --get 'branch.scott/route-gh.pushRemote'",
    );

    // While it runs, asking again returns the same child.
    expect(
      await harness.behavior.callRpc("createPullRequest", {
        threadId: "thread-a",
        branch: "scott/route-gh",
        head,
      }),
    ).toEqual(git);
    expect(world.spawned).toHaveLength(1);
    expect(await harness.behavior.callRpc("publishRequests", { threadId: "thread-a" })).toEqual({
      requests: [
        {
          branch: "scott/route-gh",
          threadId: (git as { threadId: string }).threadId,
          running: true,
        },
      ],
    });

    // A GitButler checkout opens it with `but pr new`.
    await harness.behavior.callRpc("createPullRequest", {
      threadId: "thread-b",
      branch: "scott/route-gh",
      head,
    });
    expect(world.spawned![1]!.prompt).toContain("but pr new 'scott/route-gh' -F <file>");
  });

  test("a stopped child no longer counts, so Create PR starts a new one", async () => {
    const world = twoHosts();
    const { harness } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    const input = { threadId: "thread-a", branch: "scott/route-gh", head: branch().head! };
    await harness.behavior.callRpc("createPullRequest", input);
    world.idle = [world.spawned![0]!.id];
    expect(
      await harness.behavior.callRpc("publishRequests", { threadId: "thread-a" }),
    ).toMatchObject({
      requests: [{ running: false }],
    });
    await harness.behavior.callRpc("createPullRequest", input);
    expect(world.spawned).toHaveLength(2);
  });
});
