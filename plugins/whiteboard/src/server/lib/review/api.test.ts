import { randomUUID } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../migrations.ts";
import { installDatabase } from "../sqlite.ts";
import { type ReviewApi, createReviewApi } from "./api.ts";
import { LocalReviewData } from "./local-data.ts";
import { ReviewStore } from "./store.ts";

let host: ReturnType<typeof createFakePluginHost>;
let store: ReviewStore;
let data: LocalReviewData;
let reviewId: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  host = createFakePluginHost({ pluginId: "whiteboard" });
  migrate(host.bb);
  store = new ReviewStore(installDatabase(host.bb.storage.database()), {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
  data = new LocalReviewData(store);
  ({ reviewId } = await store.execute({
    commandId: randomUUID(),
    operation: {
      type: "create",
      source: "pins",
      title: "Commits",
      pins: { repositoryId: "repo", base: "base-commit", head: "head-commit" },
    },
  }));
});

afterEach(async () => {
  await data.close();
  await store.close();
  await host.harness.dispose();
});

describe("scratchpad aliases", () => {
  // Which alias rule each operation's session id goes through. Former POST
  // routes and commands take `writableId`, which refuses the read-only legacy
  // shared pad; reads take `resolveId`. Operations without a session take neither.
  const table: Record<keyof ReviewApi, "read" | "write" | "none"> = {
    status: "none",
    capabilities: "none",
    instructions: "none",
    catalog: "none",
    liveSession: "read",
    sessionVersion: "read",
    inspect: "read",
    history: "read",
    activity: "write",
    open: "write",
    command: "write",
    lenses: "read",
    progress: "read",
    markProgress: "write",
    environment: "write",
    workspaceCleanup: "none",
    registerRepository: "none",
    resolvePins: "none",
    upload: "none",
    source: "write",
    file: "read",
    tree: "read",
    changedFiles: "read",
    diff: "read",
    commits: "read",
    stack: "read",
    map: "read",
    resource: "read",
    copyContext: "write",
  };

  const call = (api: ReviewApi, id: string): Record<keyof ReviewApi, () => Promise<unknown>> => ({
    status: () => api.status(),
    capabilities: () => api.capabilities(),
    instructions: () => api.instructions({}),
    catalog: () => api.catalog({}),
    liveSession: () => api.liveSession({ reviewId: id }),
    sessionVersion: () => api.sessionVersion({ reviewId: id, version: 0 }),
    inspect: () => api.inspect({ reviewId: id }),
    history: () => api.history({ reviewId: id }),
    activity: () => api.activity({ reviewId: id, action: "begin", leaseId: randomUUID() }),
    open: () => api.open({ reviewId: id }),
    command: () =>
      api.command(
        { commandId: randomUUID(), operation: { type: "rename", reviewId: id, title: "T" } },
        { signal },
      ),
    lenses: () => api.lenses({ reviewId: id }, { signal }),
    progress: () => api.progress({ reviewId: id }, { signal }),
    markProgress: () =>
      api.markProgress({ reviewId: id, version: 0, files: [], viewed: true }, { signal }),
    environment: () => api.environment({ reviewId: id }),
    workspaceCleanup: () => api.workspaceCleanup({}),
    registerRepository: () => api.registerRepository({ path: "/nowhere" }),
    resolvePins: () => api.resolvePins({ repositoryId: "repo", base: "a", head: "b" }),
    upload: () => api.upload({ id: randomUUID(), repositoryId: "repo", kind: "image", base64: "" }),
    source: () =>
      api.source({
        reviewId: id,
        source: { file: "a.ts", side: "head", fromLine: 1, toLine: 1 },
      }),
    file: () => api.file({ reviewId: id, side: "head", file: "a.ts" }),
    tree: () => api.tree({ reviewId: id }),
    changedFiles: () => api.changedFiles({ reviewId: id }),
    diff: () => api.diff({ reviewId: id }),
    commits: () => api.commits({ reviewId: id }),
    stack: () => api.stack({ reviewId: id }),
    map: () => api.map({ reviewId: id, resourceId: "map" }),
    resource: () => api.resource({ reviewId: id, resourceId: "image" }),
    copyContext: () =>
      api.copyContext({
        reviewId: id,
        selection: { target: { kind: "text", quote: "q" }, title: "T" },
      }),
  });

  it.each(Object.keys(table) as (keyof ReviewApi)[])(
    "%s resolves its session id as the table says",
    async (operation) => {
      const resolved: string[] = [];
      const api = createReviewApi({
        store,
        data,
        resolveId: (id) => (resolved.push(`read ${id}`), reviewId),
        writableId: (id) => (resolved.push(`write ${id}`), reviewId),
      });

      // Only the id's route matters; the operation may fail later on fixture source.
      await call(api, "alias")
        [operation]()
        .catch(() => {});

      const access = table[operation];
      expect(resolved).toEqual(access === "none" ? [] : [`${access} alias`]);
    },
  );
});

describe("language checkouts", () => {
  // bb prepares none, so agents see the empty answers Desktop gives a
  // repository with no prepare configuration.
  it("reports no environment issues for a commits target", async () => {
    const api = createReviewApi({ store, data });

    expect(store.read(reviewId).source?.target).toEqual({
      kind: "commits",
      repositoryId: "repo",
      base: "base-commit",
      head: "head-commit",
    });
    await expect(api.environment({ reviewId })).resolves.toEqual({ issues: [] });
  });

  it("reports no cleanup failures, and not-found for a workspace it never listed", async () => {
    const api = createReviewApi({ store, data });

    await expect(api.workspaceCleanup({})).resolves.toEqual({ failures: [] });
    await expect(api.workspaceCleanup({ workspaceId: "w-1" })).rejects.toMatchObject({
      message: "Cleanup failure not found.",
      status: 404,
    });
  });

  it("opens and creates without environmentIssues", async () => {
    const api = createReviewApi({
      store,
      data,
      open: async () => ({ softwareMapEnabled: false }),
    });

    await expect(api.open({ reviewId })).resolves.toEqual({ ok: true, softwareMapEnabled: false });
    const created = await api.command(
      {
        commandId: randomUUID(),
        operation: {
          type: "create",
          source: "pins",
          title: "Opened",
          pins: { repositoryId: "repo", base: "base-commit", head: "head-commit" },
        },
      },
      { signal },
    );
    expect(created).toMatchObject({ opened: true, softwareMapEnabled: false });
    expect(created).not.toHaveProperty("environmentIssues");
  });
});

describe("input budgets", () => {
  it("refuses a command over 1 MiB of JSON before writing anything", async () => {
    const api = createReviewApi({ store, data });

    await expect(
      api.command(
        {
          commandId: randomUUID(),
          operation: { type: "rename", reviewId, title: "x".repeat(1024 * 1024) },
        },
        { signal },
      ),
    ).rejects.toMatchObject({ message: "Request body exceeds 1 MiB.", status: 400 });
    expect(store.read(reviewId).title).toBe("Commits");
  });

  it("counts UTF-8 bytes, not characters", async () => {
    const api = createReviewApi({ store, data });
    // 400 Ki characters of three bytes each: under 1 Mi characters, over 1 MiB.
    const title = "€".repeat(400 * 1024);

    await expect(
      api.command(
        { commandId: randomUUID(), operation: { type: "rename", reviewId, title } },
        { signal },
      ),
    ).rejects.toThrow("Request body exceeds 1 MiB.");
  });

  it("refuses an upload over 8 MiB of JSON", async () => {
    const api = createReviewApi({ store, data });

    await expect(
      api.upload({
        id: randomUUID(),
        repositoryId: "repo",
        kind: "image",
        base64: "A".repeat(8 * 1024 * 1024),
      }),
    ).rejects.toThrow(`Request body exceeds ${8 * 1024 * 1024} bytes.`);
  });
});
