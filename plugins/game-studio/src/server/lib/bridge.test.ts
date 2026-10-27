import { expect, test } from "bun:test";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

/*
 * The bridge is what the Worker calls to run agentic work on bb. These drive its routes the way
 * the Worker does: JSON bodies, ids in bodies, statuses in the bridge's vocabulary.
 */
const post = async (
  harness: { fetchHttp(method: string, path: string, init?: RequestInit): Promise<Response> },
  path: string,
  body: unknown,
) => {
  const response = await harness.fetchHttp("POST", path, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

test("ping answers with the bridge version", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "game-studio" });
  await plugin(bb);
  const response = await harness.fetchHttp("GET", "/ping");
  expect(await response.json()).toEqual({ ok: true, pluginVersion: "1", serverMachine: null });
});

test("spawn places a hidden thread on the named machine in the game's checkout", async () => {
  const spawned: unknown[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host-a", name: "cardinal", status: "connected" }),
          makeHostResponse({ id: "host-b", name: "spare", status: "disconnected" }),
        ],
      },
      // bb knows the game checkout at /game on cardinal, and nothing at /elsewhere.
      environments: {
        list: async (args?: { path?: string }) =>
          (args?.path === "/game" ? [{ id: "env_game", path: "/game" }] : []) as never,
      },
      threads: {
        spawn: async (args: unknown) => {
          spawned.push(args);
          return makeThreadResponse({ id: "thr_new", status: "pending", title: "Write the brief" });
        },
      },
    },
  });
  await plugin(bb);
  const { status, body } = await post(harness, "/threads/spawn", {
    title: "Write the brief",
    prompt: "Write a brief for the moon level.",
    images: ["data:image/png;base64,AAAA"],
    placement: { projectId: "project", machine: "cardinal", rootPath: "/game" },
    provider: { id: "codex", model: "gpt-6", reasoningLevel: "high" },
    metadata: { gameStudioJobId: "job", gameStudioGameId: "game" },
  });
  expect(status).toBe(200);
  expect(body).toEqual({ threadId: "thr_new", status: "queued", title: "Write the brief" });
  // A path bb has no checkout at never gets a thread, whatever the Worker was told.
  const elsewhere = await post(harness, "/threads/spawn", {
    title: "Write the brief",
    prompt: "Write a brief.",
    placement: { projectId: "project", machine: "cardinal", rootPath: "/elsewhere" },
  });
  expect(elsewhere.status).toBe(500);
  expect(elsewhere.body.error).toMatch(/no checkout at \/elsewhere/);
  expect(spawned).toHaveLength(1);
  expect(spawned[0]).toMatchObject({
    projectId: "project",
    visibility: "hidden",
    providerId: "codex",
    model: "gpt-6",
    reasoningLevel: "high",
    origin: "plugin",
    originPluginId: "game-studio",
    title: "Write the brief",
    pluginMetadata: { gameStudioJobId: "job", gameStudioGameId: "game" },
    environment: {
      type: "host",
      hostId: "host-a",
      workspace: { type: "unmanaged", path: "/game" },
    },
    input: [
      { type: "text", text: "Write a brief for the moon level.", mentions: [] },
      { type: "image", url: "data:image/png;base64,AAAA" },
    ],
  });
});

test("spawn without a project uses the personal workspace on a connected machine", async () => {
  const spawned: unknown[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host-b", name: "spare", status: "disconnected" }),
          makeHostResponse({ id: "host-a", name: "cardinal", status: "connected" }),
        ],
      },
      projects: {
        list: async () => [{ id: "proj_personal", kind: "personal", name: "Personal" }] as never,
      },
      threads: {
        spawn: async (args: unknown) => {
          spawned.push(args);
          return makeThreadResponse({ id: "thr_new", status: "active" });
        },
      },
    },
  });
  await plugin(bb);
  const { body } = await post(harness, "/threads/spawn", {
    title: "Draft",
    prompt: "Draft a palette.",
  });
  expect(body).toMatchObject({ threadId: "thr_new", status: "active" });
  expect(spawned[0]).toMatchObject({
    projectId: "proj_personal",
    environment: { type: "host", hostId: "host-a", workspace: { type: "personal" } },
  });
});

test("get, output and stop speak the bridge's statuses, for the threads it spawned", async () => {
  let status: "active" | "idle" | "error" = "active";
  const stops: unknown[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host-a", name: "cardinal", status: "connected" }),
        ],
      },
      projects: {
        list: async () => [{ id: "proj_personal", kind: "personal", name: "Personal" }] as never,
      },
      threads: {
        spawn: async (args: { title?: string }) =>
          makeThreadResponse({ id: args.title ?? "thr_untitled", status: "pending" }),
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId === "gone") throw new Error("Thread not found");
          return makeThreadResponse({
            id: threadId,
            status,
            archivedAt: threadId === "old" ? 5 : null,
          });
        },
        output: async () => ({ output: "# Brief\n\nThe moon." }) as never,
        stop: async (args: unknown) => {
          stops.push(args);
          status = "idle";
          return { ok: true } as never;
        },
      },
    },
  });
  await plugin(bb);
  // The bridge spawned thr_1, gone and old; any other thread on this bb is not its to touch.
  for (const id of ["thr_1", "gone", "old"])
    await post(harness, "/threads/spawn", { title: id, prompt: "Go." });
  const foreign = await post(harness, "/threads/get", { threadId: "thr_someone_elses" });
  expect(foreign.status).toBe(500);
  expect(foreign.body.error).toMatch(/not started by Game Studio/);
  expect((await post(harness, "/threads/stop", { threadId: "thr_someone_elses" })).status).toBe(
    500,
  );
  expect((await post(harness, "/threads/get", { threadId: "thr_1" })).body).toEqual({
    threadId: "thr_1",
    status: "active",
    title: null,
  });
  expect((await post(harness, "/threads/get", { threadId: "gone" })).body).toEqual({
    threadId: "gone",
    status: "deleted",
    title: null,
  });
  expect((await post(harness, "/threads/get", { threadId: "old" })).body).toMatchObject({
    status: "archived",
  });
  // Output is withheld while the thread still works.
  expect((await post(harness, "/threads/output", { threadId: "thr_1" })).body).toEqual({
    threadId: "thr_1",
    status: "active",
    output: null,
  });
  expect((await post(harness, "/threads/stop", { threadId: "thr_1" })).body).toEqual({
    threadId: "thr_1",
    status: "idle",
    title: null,
  });
  expect(stops).toEqual([{ threadId: "thr_1" }]);
  expect((await post(harness, "/threads/output", { threadId: "thr_1" })).body).toEqual({
    threadId: "thr_1",
    status: "idle",
    output: "# Brief\n\nThe moon.",
  });
  status = "error";
  expect((await post(harness, "/threads/get", { threadId: "thr_1" })).body).toMatchObject({
    status: "failed",
  });
});

test("a malformed body is refused with its issues", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "game-studio" });
  await plugin(bb);
  const { status, body } = await post(harness, "/threads/get", { thread: "thr_1" });
  expect(status).toBe(400);
  expect(body.error).toBe("invalid request");
});
