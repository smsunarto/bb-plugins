import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import type { Engine, WhiteboardSettings } from "../../shared/contracts/engine.ts";
import { panelParamsJson, panelTabId } from "../../shared/contracts/panel.ts";
import { CATALOG_TAG, sessionTag } from "../../shared/contracts/rpc.ts";
import { registerRpc } from "../rpc/contract.ts";
import type { ReviewApi } from "./review/api.ts";
import { ReviewStore, commandSchema } from "./review/store.ts";
import { createEngine } from "./engine.ts";
import { BB_PLUGIN_DATABASE } from "./sqlite.ts";
import { forgetExists } from "./host-io/fs.ts";
import { forgetRepoContext } from "./host-io/local-vcs.ts";
import { gitFixture, type GitFixture } from "./host-io/testing/git-fixture.ts";
import { WATCH_CHECK_MS } from "./host-io/watch.ts";
import {
  createInProcessHostClient,
  IN_PROCESS_HOST_ID,
  type InProcessHostClient,
} from "./host-io/testing/in-process.ts";

// Structural diff runs the diffr that ships in Whiteboard.app, which CI runners lack.
const HAS_DIFFR = existsSync(
  "/Applications/Whiteboard.app/Contents/Resources/app/review-runtime/bin/diffr",
);
let host: ReturnType<typeof createFakePluginHost>;
let bb: BbPluginApi;
let engine: Engine;
let repo: GitFixture;
let client: InProcessHostClient;
let repositoryId: string;
const tabs = new Map<string, { revision: number; tabs: Array<Record<string, unknown>> }>();
/** Background services by name. A reload re-registers them, as a new plugin load would. */
const services = new Map<string, { start(signal: AbortSignal): void | Promise<void> }>();
let scratchpadEnabled = false;
const settings: WhiteboardSettings = {
  scratchpadEnabled: () => scratchpadEnabled,
  softwareMapEnabled: () => false,
  subscribe: () => () => {},
};
/** Run operations as the engine's callers do: as `threadId` when given. */
const as = <T>(
  threadId: string | undefined,
  fn: (api: ReviewApi, signal: AbortSignal) => Promise<T>,
) => engine.run({ threadId }, (signal) => fn(engine.api, signal));
/** A command as the RPC methods and tools send it, parsed at their boundary. */
const command = (body: unknown, threadId?: string) =>
  as(threadId, (api, signal) => api.command(commandSchema.parse(body), { signal }));
const liveSession = (reviewId: string, threadId?: string) =>
  as(threadId, (api) => api.liveSession({ reviewId }));
const readFile = (
  reviewId: string,
  file: string,
  at: { version?: number; generation?: string } = {},
) => as(undefined, (api) => api.file({ reviewId, file, side: "head", ...at }));
const changedFiles = (reviewId: string) => as(undefined, (api) => api.changedFiles({ reviewId }));
const create = async (threadId?: string, live = false) => {
  const result = await command(
    {
      commandId: randomUUID(),
      operation: {
        type: "create",
        title: "Walkthrough",
        ...(live
          ? { source: "target", target: { kind: "worktree", repositoryId, base: repo.base } }
          : { source: "pins", pins: { repositoryId, base: repo.base, head: repo.head } }),
      },
    },
    threadId,
  );
  if (!("opened" in result)) throw new Error("A create answers whether it opened.");
  return result;
};

beforeEach(async () => {
  scratchpadEnabled = false;
  repo = gitFixture("whiteboard-engine-");
  host = createFakePluginHost({ pluginId: "whiteboard" });
  client = createInProcessHostClient();
  tabs.clear();
  tabs.set("t1", { revision: 0, tabs: [] });
  tabs.set("t2", { revision: 0, tabs: [] });
  services.clear();
  bb = {
    ...host.bb,
    background: {
      ...host.bb.background,
      service: (name: string, service: { start(signal: AbortSignal): void | Promise<void> }) =>
        void services.set(name, service),
    },
    hosts: { ...host.bb.hosts, experimental_client: () => client },
    sdk: {
      ...host.bb.sdk,
      hosts: {
        ...host.bb.sdk.hosts,
        list: async () => [
          { id: IN_PROCESS_HOST_ID, name: "Test host", type: "persistent", status: "connected" },
        ],
      },
      threads: {
        ...host.bb.sdk.threads,
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, environmentId: "e1" }),
        tabs: {
          get: async ({ threadId }: { threadId: string }) => structuredClone(tabs.get(threadId)),
          update: async ({
            threadId,
            tabs: next,
            expectedRevision,
          }: {
            threadId: string;
            tabs: Array<Record<string, unknown>>;
            expectedRevision: number;
          }) => {
            const state = tabs.get(threadId)!;
            if (state.revision !== expectedRevision)
              throw Object.assign(new Error("Conflict"), {
                status: 409,
                code: "thread_tabs_conflict",
              });
            state.revision++;
            state.tabs = structuredClone(next);
            return structuredClone(state);
          },
        },
      },
      environments: {
        ...host.bb.sdk.environments,
        get: async () => ({ hostId: IN_PROCESS_HOST_ID }),
      },
    },
  } as unknown as BbPluginApi;
  engine = createEngine(bb, settings);
  // Tests replace `engine` after a dispose; the handlers read the current one.
  registerRpc({
    bb,
    get engine() {
      return engine;
    },
  });
  repositoryId = (await as(undefined, (api) => api.registerRepository({ path: repo.root }))).id;
});

afterEach(async () => {
  vi.useRealTimers();
  await engine.dispose();
  await client.simulateWorkerExit();
  await host.harness.dispose();
  repo.remove();
});

test("the real store validates pinned source through the host and keeps opaque authored text", async () => {
  const created = await create();
  expect(created.opened).toBe(false);
  const leaseId = randomUUID();
  await as(undefined, (api) =>
    api.activity({ reviewId: created.reviewId, action: "begin", leaseId }),
  );
  const input = {
    commandId: randomUUID(),
    leaseId,
    operation: {
      type: "edit",
      reviewId: created.reviewId,
      edit: {
        type: "insert",
        content: { type: "markdown", markdown: "Keep session_edit byte-for-byte." },
      },
    },
  };
  const changed = await command(input);
  expect(changed).toMatchObject({ version: 1 });
  expect(await command(input)).toEqual(changed);
  expect((await liveSession(created.reviewId)).document).toEqual([
    { type: "markdown", id: "block-1", markdown: "Keep session_edit byte-for-byte." },
  ]);
  expect(await readFile(created.reviewId, "src/a.ts")).toEqual({
    text: "export const a = 10;\nexport const a2 = 20;\n",
    commit: repo.head,
    file: "src/a.ts",
    side: "head",
  });
  expect(client.calls.some((call) => call.method === "vcsCall")).toBe(true);
  expect(await as(undefined, (api) => api.environment({ reviewId: created.reviewId }))).toEqual({
    issues: [],
  });
  expect(await as(undefined, (api) => api.workspaceCleanup({}))).toEqual({ failures: [] });
});

test("calls from a thread keep its context, create durable tabs, and follow rename/dismiss", async () => {
  const created = await command(
    {
      commandId: randomUUID(),
      operation: {
        type: "create",
        source: "pins",
        title: "First",
        pins: { repositoryId, base: repo.base, head: repo.head },
      },
    },
    "t1",
  );
  expect(created).toMatchObject({ opened: true });
  expect(tabs.get("t1")!.tabs).toMatchObject([
    {
      kind: "plugin-panel",
      title: "First",
      paramsJson: JSON.stringify({ sessionId: created.reviewId }),
    },
  ]);
  expect(tabs.get("t2")!.tabs).toEqual([]);
  expect(host.harness.inspection.realtimeSignals).toContainEqual(
    expect.objectContaining({
      channel: "whiteboard:open",
      payload: expect.objectContaining({ threadId: "t1", sessionId: created.reviewId }),
    }),
  );
  await command({
    commandId: randomUUID(),
    operation: { type: "rename", reviewId: created.reviewId, title: "Renamed" },
  });
  await vi.waitFor(() => expect(tabs.get("t1")!.tabs[0]?.title).toBe("Renamed"));
  await command({
    commandId: randomUUID(),
    operation: { type: "attention", reviewId: created.reviewId, action: "dismiss" },
  });
  await vi.waitFor(() => expect(tabs.get("t1")!.tabs).toEqual([]));
});

test("a thread panel's info records the tab it shows once, so a dismissal closes it", async () => {
  const created = await create();
  const sessionRows = () =>
    bb.storage
      .database()
      .prepare("SELECT thread_id FROM session_threads WHERE session_id=?")
      .all(created.reviewId);
  // The client opened this tab itself (a Home row), so the server never wrote it.
  tabs.get("t1")!.tabs = [
    {
      id: panelTabId(panelParamsJson(created.reviewId)),
      kind: "plugin-panel",
      pluginId: "whiteboard",
      actionId: "whiteboard",
      title: "Walkthrough",
      paramsJson: panelParamsJson(created.reviewId),
    },
  ];

  await engine.info({ threadId: "t1", sessionId: created.reviewId });
  await engine.info({ threadId: "t1", sessionId: created.reviewId });
  await engine.info({ sessionId: created.reviewId });

  expect(sessionRows()).toEqual([{ thread_id: "t1" }]);
  await expect(engine.claimOpen("t1")).resolves.toBeNull();
  await command({
    commandId: randomUUID(),
    operation: { type: "attention", reviewId: created.reviewId, action: "dismiss" },
  });
  await vi.waitFor(() => expect(tabs.get("t1")!.tabs).toEqual([]));
  // The record goes once the tab write lands.
  await vi.waitFor(() => expect(sessionRows()).toEqual([]));
});

test("live sessions read fresh state, a change invalidates its session's reads, and dispose refuses", async () => {
  const created = await create();
  expect(await liveSession(created.reviewId)).toMatchObject({
    reviewId: created.reviewId,
    version: 0,
    title: "Walkthrough",
    activity: expect.objectContaining({ workingCount: 0 }),
    coverageRevision: expect.any(Number),
  });
  await command({
    commandId: randomUUID(),
    operation: { type: "rename", reviewId: created.reviewId, title: "Latest" },
  });
  expect((await liveSession(created.reviewId)).title).toBe("Latest");
  await vi.waitFor(() =>
    expect(host.harness.inspection.experimental_rpcInvalidations).toContainEqual(
      expect.arrayContaining([sessionTag(created.reviewId)]),
    ),
  );
  await engine.dispose();
  await expect(as(undefined, (api) => api.capabilities())).rejects.toMatchObject({
    status: 409,
    message: "Whiteboard is shutting down.",
  });
});

test("live worktree files expose only contained current files and commits remain read-only", async () => {
  const live = await create(undefined, true);
  expect(await readFile(live.reviewId, "src/a.ts")).toMatchObject({
    localPath: `${repo.root}/src/a.ts`,
    localRoot: repo.root,
  });
  const old = await create();
  expect(await readFile(old.reviewId, "src/a.ts")).not.toHaveProperty("localPath");
  await expect(readFile(live.reviewId, "../outside.ts")).rejects.toMatchObject({ status: 400 });
});

test("valid PNG, JPEG and WebP uploads are stored as PNG and reach the panel as base64", async () => {
  const data = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]);
  const png = PNG.sync.write({ width: 2, height: 1, data } as PNG);
  const encoded = jpeg.encode({ width: 2, height: 1, data }, 90).data;
  const webp = Buffer.from(
    "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=",
    "base64",
  );
  const upload = (base64: string, id = randomUUID()) =>
    as(undefined, (api) => api.upload({ id, repositoryId, kind: "image", base64 }));
  for (const input of [png, encoded, webp]) {
    const id = randomUUID();
    expect(await upload(input.toString("base64"), id)).toMatchObject({ id });
    const created = await create();
    const resource = (await host.harness.behavior.callRpc("resource", {
      sessionId: created.reviewId,
      resourceId: id,
    })) as { contentType: string; base64: string };
    expect(resource.contentType).toBe("image/png");
    const image = PNG.sync.read(Buffer.from(resource.base64, "base64"));
    expect([image.width, image.height]).toEqual([2, 1]);
  }
  await expect(upload(Buffer.from("invalid").toString("base64"))).rejects.toMatchObject({
    status: 400,
    message: "Provide a valid single PNG, JPEG, or WebP image (at most 20 megapixels).",
  });
});

test("RPC live-file targets use the repository host and keep explicit/historical source read-only", async () => {
  const live = await create(undefined, true);
  expect(
    await host.harness.behavior.callRpc("liveFile", { sessionId: live.reviewId, path: "src/a.ts" }),
  ).toEqual({
    target: { kind: "host", hostId: IN_PROCESS_HOST_ID, path: `${repo.root}/src/a.ts` },
  });
  expect(
    await host.harness.behavior.callRpc("liveFile", {
      sessionId: live.reviewId,
      path: "src/a.ts",
      repositoryId,
      head: repo.head,
      base: repo.base,
    }),
  ).toEqual({ target: null });
  const committed = await create();
  expect(
    await host.harness.behavior.callRpc("liveFile", {
      sessionId: committed.reviewId,
      path: "src/a.ts",
    }),
  ).toEqual({ target: null });
  expect(
    await host.harness.behavior.callRpc("liveFile", {
      sessionId: live.reviewId,
      path: "../outside.ts",
    }),
  ).toEqual({ target: null });
  const selected = await liveSession(live.reviewId);
  const leaseId = randomUUID();
  await as(undefined, (api) => api.activity({ reviewId: live.reviewId, action: "begin", leaseId }));
  await command({
    commandId: randomUUID(),
    leaseId,
    operation: {
      type: "set_target",
      reviewId: live.reviewId,
      target: { kind: "commits", repositoryId, base: repo.base, head: repo.head },
    },
  });
  expect(
    await host.harness.behavior.callRpc("liveFile", {
      sessionId: live.reviewId,
      path: "src/a.ts",
      version: selected.version,
      generation: selected.source!.pins.worktreeRevision,
    }),
  ).toEqual({ target: null });
});

test("host watching eventually invalidates cached working state after a real commit", async () => {
  repo.write("src/a.ts", "export const live = 1;\n");
  const live = await command({
    commandId: randomUUID(),
    operation: {
      type: "create",
      source: "target",
      title: "Working files",
      target: { kind: "worktree", repositoryId },
    },
  });
  expect(await changedFiles(live.reviewId)).toContainEqual(
    expect.objectContaining({ path: "src/a.ts" }),
  );
  repo.commit("Save working files");
  await vi.waitFor(async () => expect(await changedFiles(live.reviewId)).toEqual([]), {
    timeout: 5_000,
  });
});

test("worktree holds keep the refresh timer until the last release, and dispose leaves no engine timers", async () => {
  await create();
  await engine.dispose();
  vi.useFakeTimers();
  engine = createEngine(bb, settings);
  await engine.run({}, async () => {});
  const baseline = vi.getTimerCount();
  expect(baseline).toBeGreaterThan(0);
  // Two watched reads: one refresh loop, held until both leave.
  const first = engine.watchWorktrees();
  const second = engine.watchWorktrees();
  expect(vi.getTimerCount()).toBe(baseline + 1);
  first();
  expect(vi.getTimerCount()).toBe(baseline + 1);
  second();
  expect(vi.getTimerCount()).toBe(baseline);
  // A read still watched at dispose, and one that arrives after it.
  engine.watchWorktrees();
  await engine.dispose();
  engine.watchWorktrees();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

/** Two connected machines: thread-less calls can no longer fall back to the only host. */
const twoHosts = () =>
  vi.spyOn(bb.sdk.hosts, "list").mockResolvedValue([
    { id: IN_PROCESS_HOST_ID, name: "Local Mac", type: "persistent", status: "connected" },
    { id: "second-host", name: "Build Mac", type: "persistent", status: "connected" },
  ] as never);

/** bb's `ApiError` for a host whose daemon is not connected. */
const hostNotConnected = () =>
  Object.assign(new Error("Host is not connected"), {
    status: 502,
    body: { code: "host_unavailable", message: "Host is not connected" },
  });

test("repository registration reads the path on the caller's host and names both hosts when it is bound elsewhere", async () => {
  vi.spyOn(bb.sdk.environments, "get").mockResolvedValue({ hostId: "second-host" } as never);
  twoHosts();
  const before = client.calls.length;
  await expect(
    as("t2", (api) => api.registerRepository({ path: repo.root })),
  ).rejects.toMatchObject({
    status: 409,
    message: `${repo.root} is already registered from another bb host (Local Mac), and this call comes from Build Mac. Whiteboard keys checkouts by path, so one path can belong to one host. Work on this checkout from a thread on Local Mac, or register a checkout at a different path on Build Mac.`,
  });
  // The checkout at this path on the bound host is never read for a Build Mac caller.
  expect(
    client.calls.slice(before).map(({ hostId, input }) => {
      const { module, fn } = input as { module?: string; fn?: string };
      return `${hostId} ${module}.${fn}`;
    }),
  ).toEqual([
    "second-host fs.realpath",
    "second-host local-vcs.detectLocalVcs",
    "second-host fs.realpath",
  ]);
  expect(
    bb.storage
      .database()
      .prepare("SELECT host_id FROM repository_hosts WHERE repository_id=?")
      .get(repositoryId),
  ).toEqual({ host_id: IN_PROCESS_HOST_ID });
  vi.restoreAllMocks();
});

test("loading asks no host; the repo-contexts service then primes each repository's catalog group", async () => {
  await create();
  // A restart: the repository is registered and nothing is cached in memory.
  await engine.dispose();
  forgetRepoContext();
  // bb rejects host calls until the plugin factory has resolved.
  let activated = false;
  const early: string[] = [];
  const call = client.call;
  vi.spyOn(client, "call").mockImplementation(((method, input, options) => {
    if (activated) return call(method, input, options);
    early.push(method);
    return Promise.reject(
      new Error("host plugin calls are unavailable during factory registration"),
    );
  }) as typeof client.call);
  engine = createEngine(bb, settings);
  await new Promise((resolve) => setImmediate(resolve));
  expect(early).toEqual([]);
  activated = true;
  const invalidations = host.harness.inspection.experimental_rpcInvalidations;
  const seen = invalidations.length;
  await services.get("repo-contexts")!.start(new AbortController().signal);
  await vi.waitFor(() =>
    expect(invalidations.slice(seen)).toContainEqual(expect.arrayContaining([CATALOG_TAG])),
  );
  const catalog = await as(undefined, (api) => api.catalog({}));
  expect(catalog.map((review) => review.repositoryGroup)).toEqual([
    { key: `git:${repo.root}/.git`, label: path.basename(repo.root) },
  ]);
  vi.restoreAllMocks();
});

test("a repository host that is not connected is refused naming that machine, not as a crash", async () => {
  const created = await create();
  twoHosts();
  // Past the memoized root check: the next read asks the host.
  forgetExists();
  vi.spyOn(client, "call").mockRejectedValue(hostNotConnected());
  const message =
    "Local Mac is not connected to bb. Whiteboard reads this checkout on Local Mac. Reconnect it, then retry.";
  await expect(readFile(created.reviewId, "src/a.ts")).rejects.toThrow(message);
  // The panel sees a conflict it can retry, which bb does not record as a plugin crash.
  await expect(
    host.harness.behavior.callRpc("file", {
      sessionId: created.reviewId,
      side: "head",
      path: "src/a.ts",
    }),
  ).rejects.toMatchObject({ code: "conflict", message });
  vi.restoreAllMocks();
});

test("Home's info probes the hosts that hold repositories, not the caller's", async () => {
  twoHosts();
  const warn = vi.spyOn(bb.log, "warn");
  const call = client.call;
  const probed: string[] = [];
  vi.spyOn(client, "call").mockImplementation(((method, input, options) => {
    if (method !== "probe") return call(method, input, options);
    probed.push(options.hostId);
    return Promise.resolve({
      platform: "darwin",
      git: true,
      jj: false,
      gh: true,
      diffr: "/bin/diffr",
    });
  }) as typeof client.call);
  expect(await engine.info({})).toMatchObject({ structuralDiffEnabled: true });
  expect(probed).toEqual([IN_PROCESS_HOST_ID]);
  expect(warn).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

/** A second repository, bound to Build Mac (`second-host`). */
const bindDevMacRepository = () =>
  bb.storage
    .database()
    .prepare("INSERT INTO repository_hosts(repository_id, host_id) VALUES (?, ?)")
    .run("dev-mac-repository", "second-host");

const probeResult = (diffr: string | null) => ({
  platform: "darwin",
  git: true,
  jj: false,
  gh: true,
  diffr,
});

test("Home's info answers with the first host that has diffr, without waiting for a silent one", async () => {
  twoHosts();
  bindDevMacRepository();
  const call = client.call;
  vi.spyOn(client, "call").mockImplementation(((method, input, options) => {
    if (method !== "probe") return call(method, input, options);
    // Build Mac's daemon is gone and bb has not noticed yet: no answer.
    if (options.hostId === "second-host") return new Promise(() => {});
    return Promise.resolve(probeResult("/bin/diffr"));
  }) as typeof client.call);
  expect(await engine.info({})).toMatchObject({ structuralDiffEnabled: true });
  vi.restoreAllMocks();
});

test("Home's info logs a host that is not connected at debug, not as a warning", async () => {
  twoHosts();
  bindDevMacRepository();
  const warn = vi.spyOn(bb.log, "warn");
  const debug = vi.spyOn(bb.log, "debug");
  const call = client.call;
  vi.spyOn(client, "call").mockImplementation(((method, input, options) => {
    if (method !== "probe") return call(method, input, options);
    if (options.hostId === "second-host") return Promise.reject(hostNotConnected());
    return Promise.resolve(probeResult(null));
  }) as typeof client.call);
  expect(await engine.info({})).toMatchObject({ structuralDiffEnabled: false });
  expect(warn).not.toHaveBeenCalled();
  expect(debug).toHaveBeenCalledWith(
    "whiteboard: structural diff capability could not be probed: HostUnavailableError: Build Mac is not connected to bb. Whiteboard reads this checkout on Build Mac. Reconnect it, then retry.",
  );
  vi.restoreAllMocks();
});

test("a thread-less stack read asks the host of the session's repository", async () => {
  const created = await command({
    commandId: randomUUID(),
    operation: {
      type: "create",
      source: "pins",
      title: "Stacked",
      pins: { repositoryId, base: repo.base, head: repo.head },
      pullRequestUrl: "https://github.com/o/r/pull/7",
    },
  });
  twoHosts();
  const layer = {
    branch: "seven",
    pullRequestNumber: 7,
    pullRequestUrl: "https://github.com/o/r/pull/7",
    reviewUuid: null,
    reviewTitle: null,
    relation: "current",
  };
  const call = client.call;
  const asked: string[] = [];
  vi.spyOn(client, "call").mockImplementation(((method, input, options) => {
    if ((input as { module?: string }).module !== "review-stack")
      return call(method, input, options);
    asked.push(options.hostId);
    return Promise.resolve({ ok: true, value: [layer] });
  }) as typeof client.call);
  expect(await as(undefined, (api) => api.stack({ reviewId: created.reviewId }))).toEqual({
    layers: [layer],
  });
  expect(asked).toEqual([IN_PROCESS_HOST_ID]);
  vi.restoreAllMocks();
});

test("arms the checkout and its common directory with the repository's resolved common directory", async () => {
  const live = await create(undefined, true);
  await changedFiles(live.reviewId);
  const common = path.join(repo.root, ".git");
  await vi.waitFor(() =>
    expect(
      client.calls
        .filter((entry) => entry.method === "watchWorktree")
        .map((entry) => {
          const { rootPath, gitCommonDir } = entry.input as Record<string, string>;
          return { rootPath, gitCommonDir };
        }),
    ).toEqual(
      expect.arrayContaining([
        { rootPath: repo.root, gitCommonDir: common },
        { rootPath: common, gitCommonDir: common },
      ]),
    ),
  );
});

test("with no panel open, a watch the host dropped without a worker exit is armed again", async () => {
  // The check timer starts with the first armed watch, so fake it before any read.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  repo.write("src/a.ts", "export const live = 1;\n");
  const live = await create(undefined, true);
  // An agent's read: nothing renews UI interest.
  await changedFiles(live.reviewId);
  const arms = () => client.calls.filter((entry) => entry.method === "watchWorktree");
  await vi.waitFor(() => expect(arms().length).toBeGreaterThan(0));
  const watched = arms().map((entry) => (entry.input as { watchId: string }).watchId);
  // A daemon restart: the host holds no watch, and no worker exit is reported.
  for (const watchId of watched)
    await client.call("unwatchWorktree", { watchId }, { hostId: IN_PROCESS_HOST_ID });
  const before = arms().length;
  await vi.advanceTimersByTimeAsync(WATCH_CHECK_MS);
  vi.useRealTimers();
  await vi.waitFor(() =>
    expect(
      arms()
        .slice(before)
        .map((entry) => (entry.input as { watchId: string }).watchId)
        .sort(),
    ).toEqual([...watched].sort()),
  );
});

test("source bytes containing tool names reach the panel unchanged", async () => {
  const text = "export const session_edit = 'session_get';\n";
  repo.write("src/opaque.ts", text);
  repo.head = repo.commit("Opaque tool names");
  const created = await create();
  expect(
    await host.harness.behavior.callRpc("file", {
      sessionId: created.reviewId,
      side: "head",
      path: "src/opaque.ts",
    }),
  ).toEqual({ text, file: "src/opaque.ts", side: "head", commit: repo.head });
});

test("dispose waits for an in-flight source read before closing the shared database", async () => {
  const live = await create(undefined, true);
  const original = client.call.bind(client);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let suspended = false;
  client.call = (async (method, input, options) => {
    if (method === "readBlobs") {
      suspended = true;
      await gate;
    }
    return original(method, input, options);
  }) as typeof client.call;
  const read = readFile(live.reviewId, "src/a.ts");
  await expect.poll(() => suspended).toBe(true);
  let closed = false;
  const shutdown = engine.dispose().then(() => {
    closed = true;
    return true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toBe(false);
  release!();
  // The read finishes on the open database; only then does it close.
  await expect(read).resolves.toMatchObject({
    file: "src/a.ts",
    text: "export const a = 10;\nexport const a2 = 20;\n",
  });
  await shutdown;
  expect(closed).toBe(true);
  await expect(as(undefined, (api) => api.capabilities())).rejects.toThrow(
    "Whiteboard is shutting down.",
  );
});

test.skipIf(!HAS_DIFFR)(
  "dirty worktree source, structural counts and lenses retain their selected generation",
  async () => {
    repo.write(".gitignore", "ignored.txt\n");
    repo.write("order.ts", 'export const status = "queued";\n');
    repo.head = repo.commit("Order baseline");
    repo.write("order.ts", 'export const status = "staged";\n');
    repo.git("add", "order.ts");
    repo.write("order.ts", 'export const status = "processing";\n');
    repo.write("note.ts", "export const note = 1;\n");
    repo.write("ignored.txt", "private ignored content\n");
    const index = repo.git("ls-files", "--stage");
    const staged = repo.git("diff", "--cached");
    const working = repo.git("status", "--porcelain=v1");
    const { reviewId: id } = await command({
      commandId: randomUUID(),
      operation: {
        type: "create",
        source: "target",
        title: "Dirty order",
        target: { kind: "worktree", repositoryId },
      },
    });
    const saved = await as(undefined, (api) => api.sessionVersion({ reviewId: id, version: 0 }));
    expect(saved.source!.pins.base).toBe(repo.head);
    expect(saved.source!.pins.head).toBe(repo.head);
    expect(await changedFiles(id)).toEqual([
      { path: "note.ts", status: "added", additions: 1, deletions: 0 },
      { path: "order.ts", status: "modified", additions: 1, deletions: 1 },
    ]);
    const leaseId = randomUUID();
    await as(undefined, (api) =>
      api.activity({ reviewId: id, action: "begin", leaseId, scope: "lenses" }),
    );
    const lens = await command({
      commandId: randomUUID(),
      leaseId,
      operation: {
        type: "lens",
        reviewId: id,
        edit: {
          type: "insert",
          title: "Order state",
          targets: [{ kind: "files", patterns: ["order.ts"] }],
        },
      },
    });
    const report = await as(undefined, (api, signal) => api.lenses({ reviewId: id }, { signal }));
    expect(report.lenses).toContainEqual(
      expect.objectContaining({ id: lens.targetId, fileCount: 1 }),
    );
    const progress = await as(undefined, (api, signal) =>
      api.progress({ reviewId: id }, { signal }),
    );
    expect(progress.files.map((file) => file.path).sort()).toEqual(["note.ts", "order.ts"]);
    expect(progress.files.find((file) => file.path === "order.ts")!.changed).toEqual({
      base: [[0, 1]],
      head: [[0, 1]],
    });
    const catalog = await as(undefined, (api) => api.catalog({}));
    expect(catalog.find((session) => session.reviewId === id)!.diffStats).toEqual({
      fileCount: 2,
      additions: 2,
      deletions: 1,
    });
    expect(repo.git("ls-files", "--stage")).toBe(index);
    expect(repo.git("diff", "--cached")).toBe(staged);
    expect(repo.git("status", "--porcelain=v1")).toBe(working);

    for (let revision = 2; revision <= 5; revision++) {
      const previous = await liveSession(id);
      repo.write(
        "order.ts",
        `export const status = "revision ${revision}";\nexport const count = ${revision};\n`,
      );
      await vi.waitFor(
        async () => expect((await readFile(id, "order.ts")).text).toContain(`revision ${revision}`),
        { timeout: 5_000 },
      );
      expect(
        (
          await readFile(id, "order.ts", {
            version: 0,
            generation: previous.source!.pins.worktreeRevision,
          })
        ).text,
      ).toContain(revision === 2 ? "processing" : `revision ${revision - 1}`);
    }
    const current = await liveSession(id);
    const generation = current.source!.pins.worktreeRevision;
    expect(generation).not.toBe(saved.source!.pins.worktreeRevision);
    expect(await readFile(id, "order.ts", { version: 0 })).toMatchObject({
      text: 'export const status = "processing";\n',
    });
    expect(await readFile(id, "order.ts", { version: 0 })).not.toHaveProperty("localPath");
    expect((await readFile(id, "order.ts", { version: 1, generation })).text).toContain(
      "revision 5",
    );
    expect(await readFile(id, "order.ts", { version: 0, generation })).toMatchObject({
      text: 'export const status = "revision 5";\nexport const count = 5;\n',
      localPath: `${repo.root}/order.ts`,
    });
    expect(
      await host.harness.behavior.callRpc("liveFile", {
        sessionId: id,
        path: "order.ts",
        version: 1,
        generation,
      }),
    ).toEqual({
      target: { kind: "host", hostId: IN_PROCESS_HOST_ID, path: `${repo.root}/order.ts` },
    });
    expect(
      await host.harness.behavior.callRpc("liveFile", {
        sessionId: id,
        path: "order.ts",
        version: 1,
      }),
    ).toEqual({ target: null });
    expect(
      await host.harness.behavior.callRpc("liveFile", {
        sessionId: id,
        path: "order.ts",
        version: 0,
        generation: saved.source!.pins.worktreeRevision,
      }),
    ).toEqual({ target: null });
    expect(
      (await as(undefined, (api, signal) => api.progress({ reviewId: id, version: 0 }, { signal })))
        .files,
    ).toEqual(progress.files);
    await expect(
      readFile(id, "order.ts", { version: 1, generation: "0".repeat(64) }),
    ).rejects.toMatchObject({ status: 409 });
    const refs = repo
      .git("for-each-ref", "--format=%(refname)", "refs/bb-whiteboard/worktrees")
      .trim()
      .split("\n");
    expect(refs).toHaveLength(10);
    await engine.dispose();
    repo.git("gc", "--prune=now");
    engine = createEngine(bb, settings);
    expect((await readFile(id, "order.ts", { version: 0 })).text).toBe(
      'export const status = "processing";\n',
    );
  },
);

test.each(["assume-unchanged", "skip-worktree", "split-index"])(
  "retained raw CRLF source ignores %s staging optimization",
  async (flag) => {
    repo.git("config", "core.autocrlf", "true");
    if (flag === "split-index") repo.git("update-index", "--split-index");
    else repo.git("update-index", `--${flag}`, "src/a.ts");
    const indexPath = repo.git("rev-parse", "--path-format=absolute", "--git-path", "index").trim();
    const before = readFileSync(indexPath);
    const source = "export const raw = 1;\r\nexport const next = 2;\r\n";
    repo.write("src/a.ts", source);
    const live = await create(undefined, true);
    expect((await readFile(live.reviewId, "src/a.ts")).text).toBe(source);
    expect(readFileSync(indexPath)).toEqual(before);
  },
);

test.skipIf(!HAS_DIFFR)(
  "the worktree API reads exact CRLF source while Git-clean native comparisons stay empty",
  async () => {
    repo.write(".gitattributes", "*.ts text=auto\n");
    repo.head = repo.commit("Normalized baseline");
    const raw = "export const a = 10;\r\nexport const a2 = 20;\r\n";
    repo.write("src/a.ts", raw);
    expect(repo.git("diff", "--name-only")).toBe("");
    const { reviewId: id } = await command({
      commandId: randomUUID(),
      operation: {
        type: "create",
        source: "target",
        title: "Clean CRLF",
        target: { kind: "worktree", repositoryId },
      },
    });
    expect(await readFile(id, "src/a.ts")).toMatchObject({
      text: raw,
      localPath: `${repo.root}/src/a.ts`,
    });
    expect(await changedFiles(id)).toEqual([]);
    expect(
      (await as(undefined, (api, signal) => api.progress({ reviewId: id }, { signal }))).files,
    ).toEqual([]);
  },
);

test("scratchpad aliases isolate each thread's document, leases, catalog, and restored tab", async () => {
  scratchpadEnabled = true;
  const [first, second] = await Promise.all([
    liveSession("scratchpad", "t1"),
    liveSession("scratchpad", "t2"),
  ]);
  expect(first).toMatchObject({ kind: "scratchpad", title: "Scratchpad", document: [] });
  expect(second).toMatchObject({ kind: "scratchpad", title: "Scratchpad", document: [] });
  expect(first.reviewId).not.toBe(second.reviewId);
  const lease1 = randomUUID();
  await as("t1", (api) =>
    api.activity({ reviewId: "scratchpad", action: "begin", leaseId: lease1 }),
  );
  await as("t2", (api) =>
    api.activity({ reviewId: "scratchpad", action: "begin", leaseId: randomUUID() }),
  );
  await command(
    {
      commandId: randomUUID(),
      leaseId: lease1,
      operation: {
        type: "edit",
        reviewId: "scratchpad",
        edit: {
          type: "insert",
          content: { type: "markdown", markdown: "Only thread one's design" },
        },
      },
    },
    "t1",
  );
  expect((await liveSession("scratchpad", "t1")).document).toEqual([
    expect.objectContaining({ type: "markdown", markdown: "Only thread one's design" }),
  ]);
  expect((await liveSession("scratchpad", "t2")).document).toEqual([]);
  const catalog = async (threadId?: string) =>
    (await as(threadId, (api) => api.catalog({}))).map((row) => row.reviewId);
  expect(await catalog("t1")).toEqual([first.reviewId]);
  expect(await catalog("t2")).toEqual([second.reviewId]);
  expect(await engine.info({ threadId: "t2", sessionId: "scratchpad" })).toMatchObject({
    sessionId: second.reviewId,
  });
  await engine.dispose();
  engine = createEngine(bb, settings);
  expect(await liveSession("scratchpad", "t1")).toMatchObject({
    reviewId: first.reviewId,
    document: [expect.objectContaining({ markdown: "Only thread one's design" })],
  });
  expect(await liveSession("scratchpad", "t2")).toMatchObject({
    reviewId: second.reviewId,
    document: [],
  });
});

test("another thread cannot read, open, lease, edit, or restore a scratchpad by its canonical id", async () => {
  scratchpadEnabled = true;
  const own = await liveSession("scratchpad", "t1");
  const id = own.reviewId;
  const notFound = { status: 404 };
  await expect(liveSession(id, "t2")).rejects.toMatchObject(notFound);
  await expect(as("t2", (api) => api.history({ reviewId: id }))).rejects.toMatchObject(notFound);
  await expect(as("t2", (api) => api.inspect({ reviewId: id }))).rejects.toMatchObject(notFound);
  await expect(
    as("t2", (api) => api.activity({ reviewId: id, action: "begin", leaseId: randomUUID() })),
  ).rejects.toMatchObject(notFound);
  await expect(as("t2", (api) => api.open({ reviewId: id }))).rejects.toMatchObject(notFound);
  for (const operation of [
    {
      type: "edit",
      reviewId: id,
      edit: { type: "insert", content: { type: "markdown", markdown: "Wrong thread" } },
    },
    { type: "restore", reviewId: id, version: own.version },
  ])
    await expect(command({ commandId: randomUUID(), operation }, "t2")).rejects.toMatchObject(
      notFound,
    );
  await expect(engine.info({ threadId: "t2", sessionId: id })).rejects.toThrow("another BB thread");
  expect((await liveSession("scratchpad", "t1")).document).toEqual([]);
  await expect(liveSession("scratchpad")).rejects.toMatchObject({ status: 409 });
  expect(await as(undefined, (api) => api.catalog({}))).toEqual([]);
});

test("legacy shared scratchpad content is preserved but never seeds or lists in a thread", async () => {
  const legacy = new ReviewStore(BB_PLUGIN_DATABASE, {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
  await legacy.ensureScratchpad();
  await legacy.execute({
    commandId: randomUUID(),
    operation: {
      type: "edit",
      reviewId: "scratchpad",
      edit: {
        type: "insert",
        content: { type: "markdown", markdown: "Old shared JetStream explanation" },
      },
    },
  });
  scratchpadEnabled = true;
  const fresh = await liveSession("scratchpad", "t1");
  expect(fresh).toMatchObject({ title: "Scratchpad", kind: "scratchpad", document: [] });
  const catalog = (threadId?: string) => as(threadId, (api) => api.catalog({}));
  expect((await catalog("t1")).map((row) => row.reviewId)).toEqual([fresh.reviewId]);
  expect(legacy.read("scratchpad").document).toEqual([
    expect.objectContaining({ markdown: "Old shared JetStream explanation" }),
  ]);
  expect(await catalog()).toEqual([
    expect.objectContaining({
      reviewId: "scratchpad",
      title: "Legacy shared scratchpad (read-only)",
    }),
  ]);
  expect((await liveSession("scratchpad")).document).toEqual([
    expect.objectContaining({ markdown: "Old shared JetStream explanation" }),
  ]);
  await expect(
    command({
      commandId: randomUUID(),
      operation: {
        type: "edit",
        reviewId: "scratchpad",
        edit: {
          type: "insert",
          content: { type: "markdown", markdown: "Do not change old content" },
        },
      },
    }),
  ).rejects.toMatchObject({ status: 409 });
  await legacy.close();
  scratchpadEnabled = false;
  await expect(liveSession(fresh.reviewId, "t1")).rejects.toMatchObject({ status: 409 });
});
