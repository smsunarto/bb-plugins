import { definePlugin } from "@bb-kit/core/plugin";
import { api } from "../rpc/api.ts";
import { liveFile } from "../rpc/live-file.ts";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import type { Engine, WhiteboardSettings } from "../../shared/contracts/engine.ts";
import { ReviewStore } from "./vendor/review/src/review-api/store.ts";
import { createEngine, collectApiResponse, UI_INTEREST_TTL_MS } from "./engine.ts";
import { gitFixture, type GitFixture } from "./host-io/testing/git-fixture.ts";
import {
  createInProcessHostClient,
  IN_PROCESS_HOST_ID,
  type InProcessHostClient,
} from "./host-io/testing/in-process.ts";

let host: ReturnType<typeof createFakePluginHost>;
let bb: BbPluginApi;
let engine: Engine;
let repo: GitFixture;
let client: InProcessHostClient;
let repositoryId: string;
const tabs = new Map<string, { revision: number; tabs: Array<Record<string, unknown>> }>();
const settings: WhiteboardSettings = {
  scratchpadEnabled: () => false,
  softwareMapEnabled: () => false,
  subscribe: () => () => {},
};
const post = async (path: string, body: unknown, threadId?: string) => {
  const response = await engine.request({
    method: "POST",
    path,
    body: JSON.stringify(body),
    threadId,
  });
  return { status: response.status, body: JSON.parse(response.body) };
};
const get = async (path: string) => {
  const response = await engine.request({ method: "GET", path });
  return { status: response.status, body: JSON.parse(response.body) };
};
const create = async (threadId?: string, live = false) => {
  const result = await post(
    "/commands",
    {
      commandId: randomUUID(),
      operation: {
        type: "create",
        title: "Walkthrough",
        ...(live
          ? { target: { kind: "worktree", repositoryId, base: repo.base } }
          : { pins: { repositoryId, base: repo.base, head: repo.head } }),
      },
    },
    threadId,
  );
  expect(result.status).toBe(200);
  return result.body as { reviewId: string; version: number; opened: boolean };
};

beforeEach(async () => {
  repo = gitFixture("whiteboard-engine-");
  host = createFakePluginHost({ pluginId: "whiteboard" });
  client = createInProcessHostClient();
  tabs.clear();
  tabs.set("t1", { revision: 0, tabs: [] });
  tabs.set("t2", { revision: 0, tabs: [] });
  bb = {
    ...host.bb,
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
  await definePlugin({
    pluginId: "whiteboard",
    rpc: { api, liveFile },
    services: () => ({ engine }),
  })(bb);
  const registered = await post("/repositories", { path: repo.root });
  expect(registered.status).toBe(200);
  repositoryId = registered.body.id;
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
  expect(await post(`/${created.reviewId}/activity`, { action: "begin", leaseId })).toMatchObject({
    status: 200,
  });
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
  const changed = await post("/commands", input);
  expect(changed).toMatchObject({ status: 200, body: { version: 1 } });
  expect(await post("/commands", input)).toEqual(changed);
  const snapshot = await get(`/${created.reviewId}?full=true`);
  expect(snapshot.body.document).toEqual([
    { type: "markdown", id: "block-1", markdown: "Keep session_edit byte-for-byte." },
  ]);
  const file = await get(`/${created.reviewId}/file?file=src/a.ts&side=head`);
  expect(file).toEqual({
    status: 200,
    body: {
      text: "export const a = 10;\nexport const a2 = 20;\n",
      commit: repo.head,
      file: "src/a.ts",
      side: "head",
    },
  });
  expect(client.calls.some((call) => call.method === "vcsCall")).toBe(true);
  expect(await post(`/${created.reviewId}/environment`, {})).toEqual({
    status: 200,
    body: { issues: [] },
  });
  expect(await post("/workspace-cleanup", {})).toEqual({ status: 200, body: { failures: [] } });
});

test("loopback calls retain thread context, create durable tabs, and follow rename/dismiss", async () => {
  const created = await engine.withThread({ threadId: "t1" }, () =>
    engine.client().post<{ reviewId: string; opened: boolean }>("/commands", {
      commandId: randomUUID(),
      operation: {
        type: "create",
        title: "First",
        pins: { repositoryId, base: repo.base, head: repo.head },
      },
    }),
  );
  expect(created.opened).toBe(true);
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
  await post("/commands", {
    commandId: randomUUID(),
    operation: { type: "rename", reviewId: created.reviewId, title: "Renamed" },
  });
  await vi.waitFor(() => expect(tabs.get("t1")!.tabs[0]?.title).toBe("Renamed"));
  await post("/commands", {
    commandId: randomUUID(),
    operation: { type: "attention", reviewId: created.reviewId, action: "dismiss" },
  });
  await vi.waitFor(() => expect(tabs.get("t1")!.tabs).toEqual([]));
});

test("watch snapshots cancel their subscriptions and refetch fresh state", async () => {
  const created = await create();
  let watchSubscriptions = 0;
  const subscribe = ReviewStore.prototype.subscribe;
  const spy = vi
    .spyOn(ReviewStore.prototype, "subscribe")
    .mockImplementation(function (this: ReviewStore, listener) {
      watchSubscriptions++;
      const off = subscribe.call(this, listener);
      return () => {
        watchSubscriptions--;
        off();
      };
    });
  expect(
    bb.storage
      .database()
      .prepare("SELECT host_id FROM repository_hosts WHERE repository_id=?")
      .get(repositoryId),
  ).toEqual({ host_id: IN_PROCESS_HOST_ID });
  const response = await engine.request({ method: "GET", path: `/${created.reviewId}/watch` });
  expect(response.contentType).toContain("application/x-ndjson");
  expect(response.body.split("\n")).toHaveLength(2);
  expect(JSON.parse(response.body).version).toBe(0);
  expect(watchSubscriptions).toBe(0);
  await post("/commands", {
    commandId: randomUUID(),
    operation: { type: "rename", reviewId: created.reviewId, title: "Latest" },
  });
  const refreshed = await engine.request({ method: "GET", path: `/${created.reviewId}/watch` });
  expect(JSON.parse(refreshed.body).title).toBe("Latest");
  await vi.waitFor(() =>
    expect(host.harness.inspection.realtimeSignals).toContainEqual(
      expect.objectContaining({
        channel: "whiteboard:changed",
        payload: expect.objectContaining({ kind: "review", reviewId: created.reviewId }),
      }),
    ),
  );
  await engine.dispose();
  expect((await engine.request({ method: "GET", path: "/capabilities" })).status).toBe(503);
  await expect(engine.client().read("/capabilities")).rejects.toThrow(
    "Whiteboard is shutting down.",
  );
  expect(UI_INTEREST_TTL_MS).toBe(90_000);
  spy.mockRestore();
});

test("live worktree /file exposes only contained current files and commits remain read-only", async () => {
  const live = await create(undefined, true);
  expect(await get(`/${live.reviewId}/file?file=src/a.ts&side=head`)).toMatchObject({
    status: 200,
    body: { localPath: `${repo.root}/src/a.ts`, localRoot: repo.root },
  });
  const old = await create();
  expect((await get(`/${old.reviewId}/file?file=src/a.ts&side=head`)).body).not.toHaveProperty(
    "localPath",
  );
  expect((await get(`/${live.reviewId}/file?file=../outside.ts&side=head`)).status).toBe(400);
});

test("valid PNG, JPEG and WebP uploads are stored as PNG and binary tunnel responses are base64", async () => {
  const data = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]);
  const png = PNG.sync.write({ width: 2, height: 1, data } as PNG);
  const encoded = jpeg.encode({ width: 2, height: 1, data }, 90).data;
  const webp = Buffer.from(
    "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=",
    "base64",
  );
  for (const input of [png, encoded, webp]) {
    const id = randomUUID();
    expect(
      await post("/resources", {
        id,
        repositoryId,
        kind: "image",
        base64: input.toString("base64"),
      }),
    ).toMatchObject({ status: 200, body: { id } });
    const created = await create();
    const response = await engine.request({
      method: "GET",
      path: `/${created.reviewId}/resources/${id}`,
    });
    expect(response).toMatchObject({ status: 200, contentType: "image/png", encoding: "base64" });
    const image = PNG.sync.read(Buffer.from(response.body, "base64"));
    expect([image.width, image.height]).toEqual([2, 1]);
  }
  expect(
    await post("/resources", {
      id: randomUUID(),
      repositoryId,
      kind: "image",
      base64: Buffer.from("invalid").toString("base64"),
    }),
  ).toEqual({
    status: 400,
    body: { error: "Provide a valid single PNG, JPEG, or WebP image (at most 20 megapixels)." },
  });
});

test("finite NDJSON is complete, watches return exactly one line, and every collector cancels", async () => {
  let cancellations = 0;
  const stream = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"n":1}\n{"n":2}\n'));
        },
        cancel() {
          cancellations++;
        },
      }),
      { headers: { "content-type": "application/x-ndjson" } },
    );
  expect((await collectApiResponse(stream(), true)).body).toBe('{"n":1}\n');
  expect(cancellations).toBe(1);
  const complete = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"n":1}\n'));
        controller.enqueue(new TextEncoder().encode('{"n":2}\n'));
        controller.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
  expect((await collectApiResponse(complete, false)).body).toBe('{"n":1}\n{"n":2}\n');
  const tooLarge = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
      },
      cancel() {
        cancellations++;
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
  expect(await collectApiResponse(tooLarge, false)).toMatchObject({ status: 413 });
  expect(cancellations).toBe(2);
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
  const selected = (await get(`/${live.reviewId}?full=true`)).body;
  const leaseId = randomUUID();
  expect((await post(`/${live.reviewId}/activity`, { action: "begin", leaseId })).status).toBe(200);
  expect(
    (
      await post("/commands", {
        commandId: randomUUID(),
        leaseId,
        operation: {
          type: "set_target",
          reviewId: live.reviewId,
          target: { kind: "commits", repositoryId, base: repo.base, head: repo.head },
        },
      })
    ).status,
  ).toBe(200);
  expect(
    await host.harness.behavior.callRpc("liveFile", {
      sessionId: live.reviewId,
      path: "src/a.ts",
      version: selected.version,
      generation: selected.pins.worktreeRevision,
    }),
  ).toEqual({ target: null });
});

test("host watching eventually invalidates cached working state after a real commit", async () => {
  repo.write("src/a.ts", "export const live = 1;\n");
  const { body: live } = await post("/commands", {
    commandId: randomUUID(),
    operation: {
      type: "create",
      title: "Working files",
      target: { kind: "worktree", repositoryId },
    },
  });
  expect((await get(`/${live.reviewId}/diff?format=files`)).body).toContainEqual(
    expect.objectContaining({ path: "src/a.ts" }),
  );
  repo.commit("Save working files");
  await vi.waitFor(
    async () => expect((await get(`/${live.reviewId}/diff?format=files`)).body).toEqual([]),
    { timeout: 5_000 },
  );
});

test("interest expires after 90 seconds and dispose leaves no engine timers", async () => {
  const created = await create();
  await engine.dispose();
  vi.useFakeTimers();
  engine = createEngine(bb, settings);
  await engine.withThread({}, async () => {});
  const baseline = vi.getTimerCount();
  expect(baseline).toBeGreaterThan(0);
  await engine.request({ method: "GET", path: `/${created.reviewId}/watch` });
  expect(vi.getTimerCount()).toBeGreaterThan(baseline);
  await vi.advanceTimersByTimeAsync(UI_INTEREST_TTL_MS);
  expect(vi.getTimerCount()).toBe(baseline);
  await engine.dispose();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

test("repository registration refuses a second caller host and preserves the original binding", async () => {
  vi.spyOn(bb.sdk.environments, "get").mockResolvedValue({ hostId: "second-host" } as never);
  const registered = await post("/repositories", { path: repo.root }, "t2");
  expect(registered).toEqual({
    status: 409,
    body: {
      error: `${repo.root} is already registered from another bb host (Test host). Whiteboard keys checkouts by path, so one path can belong to one host.`,
    },
  });
  expect(
    bb.storage
      .database()
      .prepare("SELECT host_id FROM repository_hosts WHERE repository_id=?")
      .get(repositoryId),
  ).toEqual({ host_id: IN_PROCESS_HOST_ID });
  vi.restoreAllMocks();
});

test("source bytes containing tool names survive the real loopback transport unchanged", async () => {
  const text = "export const session_edit = 'session_get';\n";
  repo.write("src/opaque.ts", text);
  repo.head = repo.commit("Opaque tool names");
  const created = await create();
  expect(
    await engine.client().read(`/${created.reviewId}/file?file=src/opaque.ts&side=head`),
  ).toEqual({ text, file: "src/opaque.ts", side: "head", commit: repo.head });
});

test("legacy navigator workspace writes still run atomically on the repository host", async () => {
  const live = await create(undefined, true);
  const result = await post(`/${live.reviewId}/navigator?file=src/a.ts&side=head`, {});
  expect(result.status).toBe(200);
  expect(result.body.filePath).toBe(`${repo.root}/src/a.ts`);
  expect(JSON.parse(readFileSync(result.body.workspacePath, "utf8")).folders).toEqual([
    { path: repo.root, name: repo.root.split("/").at(-1) },
  ]);
  expect(client.calls).toContainEqual(
    expect.objectContaining({
      method: "invoke",
      hostId: IN_PROCESS_HOST_ID,
      input: expect.objectContaining({ module: "fs", fn: "writePrivateJsonAtomic" }),
    }),
  );
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
  const read = expect(
    engine.request({ method: "GET", path: `/${live.reviewId}/file?side=head&file=src/a.ts` }),
  ).rejects.toMatchObject({ name: "AbortError" });
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
  await read;
  await shutdown;
  expect(closed).toBe(true);
  expect((await engine.request({ method: "GET", path: "/capabilities" })).status).toBe(503);
});

test("the assembled structural-diff tunnel returns every event through completion", async () => {
  const created = await create();
  const info = await engine.info({ sessionId: created.reviewId });
  expect(info.structuralDiffEnabled).toBe(true);
  const response = await engine.request({
    method: "GET",
    path: `/${created.reviewId}/structural-diff`,
  });
  expect(response.status).toBe(200);
  const events = response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events[0]).toMatchObject({ type: "start" });
  expect(events.at(-1)).toEqual({ type: "complete", succeeded: 3, failed: 0 });
  expect(events.filter((event) => event.type === "file")).toHaveLength(3);
  expect(client.calls.some((call) => call.method === "structuralDiff")).toBe(true);
});

test("dirty worktree source, structural counts and lenses retain their selected generation", async () => {
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
  const created = await post("/commands", {
    commandId: randomUUID(),
    operation: { type: "create", title: "Dirty order", target: { kind: "worktree", repositoryId } },
  });
  expect(created.status).toBe(200);
  const id = created.body.reviewId;
  const saved = (await get(`/${id}?full=true&version=0`)).body;
  expect(saved.pins.base).toBe(repo.head);
  expect(saved.pins.head).toBe(repo.head);
  expect((await get(`/${id}/diff?format=files`)).body).toEqual([
    { path: "note.ts", status: "added", additions: 1, deletions: 0 },
    { path: "order.ts", status: "modified", additions: 1, deletions: 1 },
  ]);
  const leaseId = randomUUID();
  expect(
    (await post(`/${id}/activity`, { action: "begin", leaseId, scope: "lenses" })).status,
  ).toBe(200);
  const lens = await post("/commands", {
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
  expect(lens.status).toBe(200);
  const report = (await get(`/${id}/lenses`)).body;
  expect(report.lenses).toContainEqual(
    expect.objectContaining({ id: lens.body.targetId, fileCount: 1 }),
  );
  const progress = (await get(`/${id}/progress`)).body;
  expect(progress.files.map((file: { path: string }) => file.path).sort()).toEqual([
    "note.ts",
    "order.ts",
  ]);
  expect(progress.files.find((file: { path: string }) => file.path === "order.ts").changed).toEqual(
    { base: [[0, 1]], head: [[0, 1]] },
  );
  const catalog = await engine.client().read<Array<{ reviewId: string; diffStats: unknown }>>("");
  expect(catalog.find((session) => session.reviewId === id)!.diffStats).toEqual({
    fileCount: 2,
    additions: 2,
    deletions: 1,
  });
  expect(repo.git("ls-files", "--stage")).toBe(index);
  expect(repo.git("diff", "--cached")).toBe(staged);
  expect(repo.git("status", "--porcelain=v1")).toBe(working);
  const structural = await engine.request({
    method: "GET",
    path: `/${id}/structural-diff?version=0&file=order.ts`,
  });
  const selected = structural.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(selected.find((event) => event.type === "file").diff.rhs.text).toBe(
    'export const status = "processing";\n',
  );
  expect(selected.at(-1)).toEqual({ type: "complete", succeeded: 1, failed: 0 });

  for (let revision = 2; revision <= 5; revision++) {
    const previous = (await get(`/${id}?full=true`)).body;
    repo.write(
      "order.ts",
      `export const status = "revision ${revision}";\nexport const count = ${revision};\n`,
    );
    await vi.waitFor(
      async () =>
        expect((await get(`/${id}/file?side=head&file=order.ts`)).body.text).toContain(
          `revision ${revision}`,
        ),
      { timeout: 5_000 },
    );
    expect(
      (
        await get(
          `/${id}/file?side=head&file=order.ts&version=0&generation=${previous.pins.worktreeRevision}`,
        )
      ).body.text,
    ).toContain(revision === 2 ? "processing" : `revision ${revision - 1}`);
  }
  const current = (await get(`/${id}?full=true`)).body;
  expect(current.pins.worktreeRevision).not.toBe(saved.pins.worktreeRevision);
  expect((await get(`/${id}/file?side=head&file=order.ts&version=0`)).body).toMatchObject({
    text: 'export const status = "processing";\n',
  });
  expect((await get(`/${id}/file?side=head&file=order.ts&version=0`)).body).not.toHaveProperty(
    "localPath",
  );
  expect(
    (
      await get(
        `/${id}/file?side=head&file=order.ts&version=1&generation=${current.pins.worktreeRevision}`,
      )
    ).body.text,
  ).toContain("revision 5");
  expect(
    (
      await get(
        `/${id}/file?side=head&file=order.ts&version=0&generation=${current.pins.worktreeRevision}`,
      )
    ).body,
  ).toMatchObject({
    text: 'export const status = "revision 5";\nexport const count = 5;\n',
    localPath: `${repo.root}/order.ts`,
  });
  expect(
    await host.harness.behavior.callRpc("liveFile", {
      sessionId: id,
      path: "order.ts",
      version: 1,
      generation: current.pins.worktreeRevision,
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
      generation: saved.pins.worktreeRevision,
    }),
  ).toEqual({ target: null });
  expect((await get(`/${id}/progress?version=0`)).body.files).toEqual(progress.files);
  const older = await engine.request({
    method: "GET",
    path: `/${id}/structural-diff?version=0&file=order.ts`,
  });
  expect(older.body).toBe(structural.body);
  expect(
    (await get(`/${id}/file?side=head&file=order.ts&version=1&generation=${"0".repeat(64)}`))
      .status,
  ).toBe(409);
  const refs = repo
    .git("for-each-ref", "--format=%(refname)", "refs/bb-whiteboard/worktrees")
    .trim()
    .split("\n");
  expect(refs).toHaveLength(10);
  await engine.dispose();
  repo.git("gc", "--prune=now");
  engine = createEngine(bb, settings);
  expect((await get(`/${id}/file?side=head&file=order.ts&version=0`)).body.text).toBe(
    'export const status = "processing";\n',
  );
});

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
    expect((await get(`/${live.reviewId}/file?side=head&file=src/a.ts`)).body.text).toBe(source);
    expect(readFileSync(indexPath)).toEqual(before);
  },
);

test("the worktree API reads exact CRLF source while Git-clean native comparisons stay empty", async () => {
  repo.write(".gitattributes", "*.ts text=auto\n");
  repo.head = repo.commit("Normalized baseline");
  const raw = "export const a = 10;\r\nexport const a2 = 20;\r\n";
  repo.write("src/a.ts", raw);
  expect(repo.git("diff", "--name-only")).toBe("");
  const created = await post("/commands", {
    commandId: randomUUID(),
    operation: { type: "create", title: "Clean CRLF", target: { kind: "worktree", repositoryId } },
  });
  expect(created.status).toBe(200);
  const id = created.body.reviewId;
  expect((await get(`/${id}/file?side=head&file=src/a.ts`)).body).toMatchObject({
    text: raw,
    localPath: `${repo.root}/src/a.ts`,
  });
  expect((await get(`/${id}/diff?format=files`)).body).toEqual([]);
  expect((await get(`/${id}/progress`)).body.files).toEqual([]);
  const structural = await engine.request({
    method: "GET",
    path: `/${id}/structural-diff?file=src/a.ts`,
  });
  expect(structural.status).toBe(200);
  const events = structural.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events[0]).toMatchObject({ type: "start", files: [] });
  expect(events).not.toContainEqual(expect.objectContaining({ type: "file" }));
  expect(events.at(-1)).toEqual({ type: "complete", succeeded: 0, failed: 0 });
});
