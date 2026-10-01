import { randomUUID } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import { migrate } from "../migrations.ts";
import { installDatabase } from "../sqlite.ts";
import { createReviewApi } from "../vendor/review/src/review-api/http.ts";
import { LocalReviewData } from "../vendor/review/src/review-api/local-data.ts";
import { ReviewStore } from "../vendor/review/src/review-api/store.ts";

// The agent-visible effect of the stub through upstream's routes (design §3.10):
// session_environment, session_workspace_cleanup and session_open/create.

let host: ReturnType<typeof createFakePluginHost>;
let store: ReviewStore;
let api: ReturnType<typeof createReviewApi>;
let reviewId: string;

const post = async (route: string, body: unknown) => {
  const response = await api.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

beforeEach(async () => {
  host = createFakePluginHost({ pluginId: "whiteboard" });
  migrate(host.bb);
  installDatabase(host.bb.storage.database());
  store = new ReviewStore("ignored.db", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
  api = createReviewApi(store, new LocalReviewData(store), async () => ({
    softwareMapEnabled: false,
  }));
  ({ reviewId } = await store.execute({
    commandId: randomUUID(),
    operation: {
      type: "create",
      title: "Commits",
      pins: { repositoryId: "repo", base: "base-commit", head: "head-commit" },
    },
  }));
});

afterEach(async () => {
  await store.close();
  await host.harness.dispose();
});

it("reports no environment issues for both sides of a commits target", async () => {
  expect(store.read(reviewId).target).toEqual({
    kind: "commits",
    repositoryId: "repo",
    base: "base-commit",
    head: "head-commit",
  });
  expect(await post(`/${reviewId}/environment`, {})).toEqual({ status: 200, body: { issues: [] } });
  expect(await post(`/${reviewId}/environment`, { retry: true })).toEqual({
    status: 200,
    body: { issues: [] },
  });
});

it("reports no cleanup failures, and a 404 for a workspace it never listed", async () => {
  expect(await post("/workspace-cleanup", {})).toEqual({ status: 200, body: { failures: [] } });
  expect(await post("/workspace-cleanup", { workspaceId: "w-1" })).toEqual({
    status: 404,
    body: { error: "Cleanup failure not found." },
  });
});

it("lists no workspaces and refuses a retry by ID", async () => {
  const list = await api.request(`/${reviewId}/workspaces`);
  expect({ status: list.status, body: await list.json() }).toEqual({ status: 200, body: [] });
  expect(await post(`/${reviewId}/workspaces/w-1/retry`, {})).toEqual({
    status: 404,
    body: { error: "Language environment not found." },
  });
});

it("opens and creates without environmentIssues", async () => {
  expect(await post(`/${reviewId}/open`, {})).toEqual({
    status: 200,
    body: { ok: true, softwareMapEnabled: false },
  });
  const created = await post("/commands", {
    commandId: randomUUID(),
    operation: {
      type: "create",
      title: "Opened",
      pins: { repositoryId: "repo", base: "base-commit", head: "head-commit" },
    },
  });
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({ opened: true, softwareMapEnabled: false });
  expect(created.body).not.toHaveProperty("environmentIssues");
});
