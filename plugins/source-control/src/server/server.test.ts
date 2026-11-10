import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { LocalValue, PullRequest, ThreadChange } from "../core/change.ts";
import type { Exec } from "../forge/github.ts";
import { createSourceControl } from "./server.ts";
import { WATCH_INTERVAL_MS } from "./thread-changes.ts";

const PLUGIN = "source-control";

function local(path: string, overrides: Partial<LocalValue> = {}): LocalValue {
  return {
    path,
    commonDir: `${path}/.git`,
    branch: "scott/route-gh",
    head: "c0ffee",
    github: { repo: { owner: "smsunarto", name: "bb-plugins" }, headOwner: "smsunarto" },
    upstream: { ref: "origin/scott/route-gh", ahead: 0, behind: 0 },
    uncommitted: [{ path: "src/a.ts", kind: "modified" }],
    moreUncommitted: 0,
    conflicted: 0,
    commits: [{ id: "c0ffee", subject: "Route gh through the checkout host" }],
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

type World = {
  hosts: Record<string, { name: string; online: boolean; local: LocalValue; ghAccounts: string[] }>;
  threads: Record<string, { hostId: string; path: string }>;
  serverAccounts: string[];
  pullRequests: unknown[];
};

function serverGh(world: World): Exec {
  return async (args) => {
    if (args[0] === "auth") {
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
            (login) =>
              `github.com\n  ✓ Logged in to github.com account ${login} (keyring)\n  - Active account: true`,
          )
          .join("\n"),
        stderr: "",
      };
    }
    return {
      code: 0,
      stdout: JSON.stringify({
        data: { repository: { pullRequests: { nodes: world.pullRequests } } },
      }),
      stderr: "",
    };
  };
}

async function start(world: World) {
  const { bb, harness } = createFakePluginHost({
    pluginId: PLUGIN,
    sdk: {
      threads: {
        get: (async ({ threadId }: { threadId: string }) => {
          const where = world.threads[threadId]!;
          return {
            ...makeThreadResponse({ id: threadId }),
            environment: {
              id: `env-${threadId}`,
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
    experimental_callHostRpc: async ({ method, hostId }) => {
      const host = world.hosts[hostId]!;
      if (!host.online) throw new Error("Host is not connected");
      if (method === "workspace")
        return { ok: true, value: { state: "branch", local: host.local } };
      if (method === "forgeAccounts") return { ok: true, value: { accounts: host.ghAccounts } };
      if (method === "forgeCall") return { ok: true, value: null };
      throw new Error(`unexpected ${method}`);
    },
  });
  await createSourceControl({ serverExec: serverGh(world), now: () => Date.now() })(bb);
  const read = async (threadId: string) =>
    (
      (await harness.behavior.callRpc("changeForThread", { keys: [threadId] })) as Record<
        string,
        ThreadChange
      >
    )[threadId]!;
  return { harness, read };
}

function twoHosts(): World {
  return {
    hosts: {
      "host-a": {
        name: "studio-mac",
        online: true,
        local: local("/Users/scott/bb-plugins"),
        ghAccounts: [],
      },
      "host-b": {
        name: "build-linux",
        online: true,
        local: local("/home/scott/bb-plugins"),
        ghAccounts: [],
      },
    },
    threads: {
      "thread-a": { hostId: "host-a", path: "/Users/scott/bb-plugins" },
      "thread-b": { hostId: "host-b", path: "/home/scott/bb-plugins" },
    },
    serverAccounts: ["smsunarto"],
    pullRequests: [],
  };
}

afterEach(() => vi.useRealTimers());

describe("identity", () => {
  test("one branch on two hosts is one Change, before and after its pull request exists", async () => {
    const world = twoHosts();
    const { harness, read } = await start(world);

    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-b" });
    const [a1, b1] = [await read("thread-a"), await read("thread-b")];
    expect(a1.state === "checkout" && a1.key).toBe(
      "gh:smsunarto/bb-plugins:smsunarto:scott/route-gh",
    );
    expect(b1.state === "checkout" && b1.key).toBe(a1.state === "checkout" && a1.key);
    expect(a1.state === "checkout" && a1.forge.read?.value).toBeNull();

    world.pullRequests = [PR];
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-b" });
    const [a2, b2] = [await read("thread-a"), await read("thread-b")];
    expect(a2.state === "checkout" && a2.key).toBe(a1.state === "checkout" && a1.key);
    // The pull request read for B is the same Change's, so A shows it without reading again.
    const pr = (a2.state === "checkout" && a2.forge.read?.value) as PullRequest;
    expect(pr).toMatchObject({
      number: 482,
      state: "open",
      isDraft: true,
      checks: { passed: 1, failed: 0, pending: 0 },
    });
    expect(b2.state === "checkout" && b2.forge.read?.value).toEqual(pr);
  });

  test("with the checkout host offline the forge facet stays clean and the local facet keeps its last value", async () => {
    const world = twoHosts();
    world.pullRequests = [PR];
    const { harness, read } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    const before = await read("thread-a");

    world.hosts["host-a"]!.online = false;
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    const after = await read("thread-a");

    if (before.state !== "checkout" || after.state !== "checkout")
      throw new Error("expected a checkout row");
    expect(after.key).toBe(before.key);
    expect(after.local.problem).toEqual({ kind: "host-offline", host: "studio-mac" });
    expect(after.local.read).toEqual(before.local.read);
    expect(after.forge.problem).toBeNull();
    expect(after.forge.read?.value).toMatchObject({ number: 482 });
  });
});

describe("forge sites", () => {
  test("without gh on the server, the pull request is read on the checkout's host", async () => {
    const world = twoHosts();
    world.serverAccounts = [];
    world.hosts["host-a"]!.ghAccounts = ["smsunarto"];
    const { harness, read } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    const row = await read("thread-a");
    expect(row.state === "checkout" && row.forge).toMatchObject({
      read: { value: null },
      problem: null,
    });
    expect(harness.inspection.experimental_hostRpcCalls.map((call) => call.method)).toContain(
      "forgeCall",
    );
  });

  test("with no signed-in gh anywhere, the forge facet says so and the local facet is unaffected", async () => {
    const world = twoHosts();
    world.serverAccounts = [];
    const { harness, read } = await start(world);
    await harness.behavior.callRpc("refreshThread", { threadId: "thread-a" });
    const row = await read("thread-a");
    if (row.state !== "checkout") throw new Error("expected a checkout row");
    expect(row.forge).toEqual({ read: null, problem: { kind: "no-site", host: "studio-mac" } });
    expect(row.local.problem).toBeNull();
    expect(row.local.read?.value.branch).toBe("scott/route-gh");
  });
});

describe("host calls", () => {
  test("serving the read never calls a host, and nothing is read while no surface watches", async () => {
    vi.useFakeTimers();
    const { harness, read } = await start(twoHosts());
    expect(await read("thread-a")).toEqual({ state: "pending" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(0);
  });

  test("a watched thread calls only its own host, and stops when the watch ends", async () => {
    vi.useFakeTimers();
    const { harness, read } = await start(twoHosts());
    const stop = harness.behavior.experimental_watchRpc("changeForThread", { key: "thread-a" });
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS * 2 + 1);
    const calls = harness.inspection.experimental_hostRpcCalls;
    expect(calls.filter((call) => call.method === "workspace").length).toBeGreaterThanOrEqual(2);
    expect(new Set(calls.map((call) => call.hostId))).toEqual(new Set(["host-a"]));
    expect((await read("thread-a")).state).toBe("checkout");

    stop();
    await vi.advanceTimersByTimeAsync(1);
    const after = calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(after);
  });
});
