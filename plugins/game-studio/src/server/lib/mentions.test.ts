import { afterEach, expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { fakeGame, fakeStudio, STUDIO_SETTINGS } from "../../../test/fake-studio.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const providerOf = (
  harness: { registrations: { mentionProviders: { id: string }[] } },
  id: string,
) => {
  const provider = harness.registrations.mentionProviders.find((entry) => entry.id === id);
  if (!provider) throw new Error(`Missing mention provider ${id}`);
  return provider as (typeof harness.registrations.mentionProviders)[number] & {
    search(ctx: unknown): unknown;
    resolve(itemId: string): unknown;
  };
};

test("a request pill resolves the studio's prepared context when the person sends", async () => {
  const studio = fakeStudio({
    "POST /api/games/game/prompt": ({ body }) => ({
      body: {
        prompt: "Build it.",
        context: `Context for ${(body as { action: string }).action}`,
        request: (body as { request: unknown }).request,
      },
    }),
  });
  cleanups.push(studio.restore);
  const { bb, harness } = createFakePluginHost({ pluginId: "game-studio", settings: STUDIO_SETTINGS });
  await plugin(bb);
  const request = { id: "req_1", action: "build", createdAt: 1 };
  const resolved = await providerOf(harness, "request").resolve(
    JSON.stringify({ gameId: "game", action: "build", documentId: "design", request }),
  );
  expect(resolved).toEqual({ context: "Context for build" });
  expect(studio.calls[0]!.body).toEqual({ action: "build", documentId: "design", request });
});

test("node mentions search the studio and attach the node's output image", async () => {
  const studio = fakeStudio({
    "GET /api/games": () => ({ body: { games: [fakeGame(), fakeGame({ id: "other", name: "Other", checkout: { projectId: "elsewhere", hostId: "remote", rootPath: "/other" } })] } }),
    "GET /api/nodes": () => ({
      body: {
        items: [
          { id: '{"gameId":"game","boardId":"main","nodeId":"hero"}', ref: { gameId: "game", boardId: "main", nodeId: "hero" }, title: "Hero", subtitle: "image · Main", icon: "Image" },
          { id: '{"gameId":"other","boardId":"main","nodeId":"x"}', ref: { gameId: "other", boardId: "main", nodeId: "x" }, title: "Elsewhere", subtitle: "image", icon: "Image" },
        ],
      },
    }),
    "GET /api/games/game/nodes/hero/context": () => ({
      body: { context: "Node hero", image: { mime: "image/png", base64: "AAAA" } },
    }),
  });
  cleanups.push(studio.restore);
  const { bb, harness } = createFakePluginHost({ pluginId: "game-studio", settings: STUDIO_SETTINGS });
  await plugin(bb);
  const provider = providerOf(harness, "canvas-node");
  // A composer in a project sees the games connected to it.
  const items = await provider.search({ trigger: "@", query: "he", projectId: "project", threadId: null });
  expect(items).toEqual([
    { id: '{"gameId":"game","boardId":"main","nodeId":"hero"}', title: "Hero", subtitle: "image · Main", icon: "Image" },
  ]);
  expect(studio.calls.find((call) => call.path.startsWith("/api/nodes"))?.path).toBe("/api/nodes?q=he");
  const resolved = await provider.resolve('{"gameId":"game","boardId":"main","nodeId":"hero"}');
  expect(resolved).toEqual({
    context: "Node hero",
    experimental_images: [
      { type: "image", url: "data:image/png;base64,AAAA", context: "Output of node hero" },
    ],
  });
});

test("the mention menu stays empty until the plugin can reach the studio", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "game-studio", settings: { studioUrl: "https://studio.test" } });
  await plugin(bb);
  expect(await providerOf(harness, "canvas-node").search({ trigger: "@", query: "", projectId: null, threadId: null })).toEqual([]);
});
