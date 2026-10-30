// Where a prompt goes, end to end through the plugin: the facts it gathers,
// how long it waits for each, and what it does when one is slow or missing.
import http2 from "node:http2";
import type net from "node:net";
import { createFakePluginHost, type FakeSdkOverrides } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "../server";

const HOST = {
  id: "h1",
  name: "Studio",
  status: "connected",
  lifecycle: { phase: "active" },
  maxPermissionMode: "full",
};
const STATS = {
  platform: "linux",
  arch: "x64",
  osRelease: "6.8",
  cpuCount: 8,
  loadAverage1m: 0.4,
  memoryTotalBytes: 16e9,
  memoryFreeBytes: 8e9,
  diskTotalBytes: 1e12,
  diskFreeBytes: 5e11,
};
const WORKTREE = {
  id: "git-worktree",
  displayName: "Worktree",
  description: "A fresh worktree",
  machineProviderId: null,
  inputs: null,
  acceptsEmptyInputs: true,
  requires: { projectless: false },
  machineAvailability: { h1: { status: "available" } },
};
const CATALOG = {
  models: [{ model: "opus", displayName: "Opus", description: "", supportedReasoningEfforts: [] }],
  providers: [
    {
      id: "claude-code",
      displayName: "Claude Code",
      capabilities: { permissionModes: ["accept-edits", "auto", "full"] },
    },
  ],
};
const ROTATION = [{ providerId: "claude-code", model: "opus", note: "", reasoningLevel: "medium" }];

function project(id: string, name: string) {
  return {
    id,
    name,
    kind: "repository",
    gitRemoteUrl: null,
    sources: [{ hostId: "h1", path: `/src/${name}`, isDefault: true }],
    threads: [],
  };
}

const never = () => new Promise<never>(() => {});
/** `value`, `ms` from now. */
const after = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const sleep = (ms: number) => after(ms, undefined);

/** One connected machine, one model, and `projects`, each with a worktree. */
async function world(
  options: {
    projects?: ReturnType<typeof project>[];
    stats?: () => Promise<unknown>;
    sdk?: FakeSdkOverrides;
  } = {},
) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "magic-compose",
    settings: { gatewayApiKey: "test-key" },
    experimental_callHostRpc: options.stats ?? (async () => STATS),
    sdk: {
      hosts: { list: async () => [HOST] },
      system: { config: async () => ({ primaryHostId: "h1" }) },
      threads: { count: async () => ({ groups: [] }) },
      projects: { list: async () => options.projects ?? [project("p1", "bb")] },
      providers: {
        models: async () => CATALOG,
        list: async () => [{ id: "claude-code", available: true }],
      },
      environments: { listProviders: async () => [WORKTREE] },
      ...options.sdk,
    },
  });
  cleanups.push(() => harness.lifecycle.dispose());
  await plugin(bb);
  await harness.behavior.callRpc("rotationSet", { entries: ROTATION });
  const preview = () =>
    harness.behavior.callRpc("preview", { text: "Fix the sidebar", projectId: null }) as Promise<{
      decision: {
        project: { id: string; source: string };
        machine: { id: string };
        model: { label: string; providerId: string; model: string };
        environment: { id: string };
      };
    }>;
  return { harness, preview };
}

/** `promise`'s outcome, or "pending" if it has none within `ms`. */
async function within<T>(ms: number, promise: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error: error as Error }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A stand-in for the Jev gateway on a local port, reached through the plugin's
 * own HTTP/2 connection. It answers every question with its first option.
 */
async function fakeGateway() {
  const server = http2.createServer();
  const requests: { questions: Record<string, { criteria: Record<string, unknown> }> }[] = [];
  server.on("stream", (stream) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as (typeof requests)[number];
      requests.push(body);
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([id, question]) => {
          const choice = Object.keys(question.criteria)[0];
          return [id, { type: "choice", choice, probabilities: { [choice ?? ""]: 0.9 } }];
        }),
      );
      stream.respond({ ":status": 200 });
      stream.end(JSON.stringify({ answers }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  const connect = http2.connect.bind(http2);
  vi.spyOn(http2, "connect").mockImplementation(((_authority: string, ...rest: never[]) =>
    connect(`http://127.0.0.1:${port}`, ...rest)) as typeof http2.connect);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const session of sessions) session.destroy();
      }),
  );
  const sessions: http2.ServerHttp2Session[] = [];
  server.on("session", (session) => sessions.push(session));
  return { requests };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("routes to the only place a prompt can go without asking Jev", async () => {
  const { preview } = await world();
  const { decision } = await preview();
  expect(decision).toMatchObject({
    project: { id: "p1", source: "only-option" },
    machine: { id: "h1" },
    model: { label: "Opus (Claude Code)", providerId: "claude-code", model: "opus" },
    environment: { id: "git-worktree" },
  });
});

it("asks Jev over the warm connection when there is a choice, and goes where it says", async () => {
  const gateway = await fakeGateway();
  const { preview } = await world({ projects: [project("p1", "bb"), project("p2", "games")] });

  const { decision } = await preview();

  expect(decision.project).toMatchObject({ id: "p1", source: "jev" });
  expect(gateway.requests).toHaveLength(1);
  expect(Object.values(gateway.requests[0]?.questions ?? {})).toEqual([
    expect.objectContaining({ criteria: expect.objectContaining({ bb: expect.any(String) }) }),
  ]);
});

it("routes without a machine's stats when it is slow to describe itself", async () => {
  const { preview } = await world({ stats: never });
  const started = Date.now();
  const outcome = await within(2_000, preview());
  expect(outcome).toMatchObject({ value: { decision: { machine: { id: "h1" } } } });
  expect(Date.now() - started).toBeGreaterThanOrEqual(300);
});

it("counts a machine as able to run a model when its provider check is slow", async () => {
  const { preview } = await world({
    sdk: { providers: { models: async () => CATALOG, list: never } },
  });
  const started = Date.now();
  const outcome = await within(2_000, preview());
  expect(outcome).toMatchObject({ value: { decision: { machine: { id: "h1" } } } });
  expect(Date.now() - started).toBeGreaterThanOrEqual(300);
});

it("routes without a project while its environments first load past a provider check, and to it once they land", async () => {
  const { harness, preview } = await world({
    sdk: { environments: { listProviders: () => after(3_000, [WORKTREE]) } },
  });

  const pending = await within(2_900, preview());
  expect(pending).toMatchObject({
    error: { message: "No connected machine can run Opus (Claude Code) in bb." },
  });

  await sleep(1_000); // the load lands 3 s after it started
  const landed = await within(1_000, preview());
  expect(landed).toMatchObject({
    value: { decision: { project: { id: "p1" }, environment: { id: "git-worktree" } } },
  });
  expect(harness.inspection.sdk.callsTo("environments.listProviders")).toHaveLength(1);
}, 10_000);

it("routes among the other projects when one project's environments cannot be read", async () => {
  const gateway = await fakeGateway();
  const { harness, preview } = await world({
    projects: [project("p1", "bb"), project("p2", "games")],
    sdk: {
      environments: {
        listProviders: async (args?: { projectId?: string }) => {
          if (args?.projectId === "p2") throw new Error("environments exploded");
          return [WORKTREE];
        },
      },
    },
  });

  const outcome = await within(4_000, preview());

  expect(outcome).toMatchObject({ value: { decision: { project: { id: "p1", source: "jev" } } } });
  expect(gateway.requests).toHaveLength(1);
  expect(harness.inspection.logEntries).toContainEqual({
    level: "warn",
    message: "environments unavailable for p2: environments exploded",
  });
}, 10_000);

it("routes without a model's catalog once it takes longer than a provider check", async () => {
  const { preview } = await world({
    sdk: {
      providers: { models: never, list: async () => [{ id: "claude-code", available: true }] },
    },
  });
  const outcome = await within(4_000, preview());
  expect(outcome).toMatchObject({
    value: { decision: { model: { label: "opus (claude-code)", model: "opus" } } },
  });
}, 10_000);

it("keeps a model's catalog that took longer than a provider check, for the next dispatch", async () => {
  const { harness, preview } = await world({
    sdk: {
      providers: {
        models: () => after(3_000, CATALOG),
        list: async () => [{ id: "claude-code", available: true }],
      },
    },
  });

  const pending = await within(2_900, preview());
  expect(pending).toMatchObject({
    value: { decision: { model: { label: "opus (claude-code)" } } },
  });

  await sleep(1_000); // the load lands 3 s after it started
  const landed = await within(1_000, preview());
  expect(landed).toMatchObject({ value: { decision: { model: { label: "Opus (Claude Code)" } } } });
  expect(harness.inspection.sdk.callsTo("providers.models")).toHaveLength(1);
}, 10_000);

it("starts and logs the thread when the CLI gives up while the spawn is under way", async () => {
  let finishSpawn!: (thread: { id: string }) => void;
  const { harness } = await world({
    sdk: {
      threads: {
        count: async () => ({ groups: [] }),
        spawn: () =>
          new Promise<{ id: string }>((resolve) => {
            finishSpawn = resolve;
          }),
      },
    },
  });
  const cli = new AbortController();

  const run = harness.behavior.runCli(["spawn", "Fix the sidebar"], { signal: cli.signal });
  await vi.waitFor(() => expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1));
  cli.abort();
  await sleep(50);
  finishSpawn({ id: "thr_spawned" });
  const result = await run;

  expect(harness.inspection.logEntries).toContainEqual({
    level: "info",
    message: expect.stringMatching(/^dispatched thr_spawned: bb · Studio · Opus \(Claude Code\)/),
  });
  expect(harness.inspection.logEntries.filter((entry) => entry.level === "error")).toEqual([]);
  expect(result).toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining("Started thr_spawned"),
  });
});

it("warms the Jev connection and refreshes what it knows, so the next dispatch reads it fresh", async () => {
  const gateway = await fakeGateway();
  const { harness, preview } = await world();
  const calls = (path: string) => harness.inspection.sdk.callsTo(path).length;

  expect(await harness.behavior.callRpc("warm", null)).toEqual({ warmed: true });
  expect(gateway.requests).toHaveLength(1); // the new connection was primed
  const environmentLoads = calls("environments.listProviders");
  const providerChecks = calls("providers.list");
  expect(environmentLoads).toBe(1);
  expect(providerChecks).toBe(1);
  expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(1);

  await preview();
  expect(calls("environments.listProviders")).toBe(environmentLoads);
  expect(calls("providers.list")).toBe(providerChecks);
  expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(1);

  await harness.behavior.callRpc("warm", null);
  expect(gateway.requests).toHaveLength(1); // already primed
  expect(calls("environments.listProviders")).toBe(environmentLoads + 1);
});

it("does not warm anything without a Jev key", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "magic-compose" });
  cleanups.push(() => harness.lifecycle.dispose());
  await plugin(bb);
  expect(await harness.behavior.callRpc("warm", null)).toEqual({ warmed: false });
});

it("describes each connected machine with its stats", async () => {
  const { harness } = await world();
  const { machines } = (await harness.behavior.callRpc("machines", null)) as {
    machines: { id: string; name: string; description: string; stats: unknown }[];
  };
  expect(machines).toEqual([
    { id: "h1", name: "Studio", description: expect.any(String), stats: STATS },
  ]);
});

it("still logs a machine that fails to describe itself after the dispatch has moved on", async () => {
  const { harness, preview } = await world({
    stats: () =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("stats exploded")), 600);
      }),
  });
  const warnings = () => harness.inspection.logEntries.filter((entry) => entry.level === "warn");

  const outcome = await within(2_000, preview());
  expect(outcome).toMatchObject({ value: { decision: { machine: { id: "h1" } } } });
  expect(warnings()).toEqual([]);

  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(warnings()).toEqual([
    {
      level: "warn",
      message: expect.stringContaining("machine stats unavailable for h1: "),
    },
  ]);
});
