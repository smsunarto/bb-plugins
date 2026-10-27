import { afterEach, expect, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { fakeGame, fakeStudio, STUDIO_SETTINGS } from "../../../test/fake-studio.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test("overview lists the studio's games and the url the app embeds", async () => {
  const studio = fakeStudio({ "GET /api/games": () => ({ body: { games: [fakeGame()] } }) });
  cleanups.push(studio.restore);
  const { bb, harness } = createFakePluginHost({ pluginId: "game-studio", settings: { ...STUDIO_SETTINGS, studioUrl: "https://studio.test/" } });
  await plugin(bb);
  expect(await harness.callRpc("overview", {})).toEqual({
    studioUrl: "https://studio.test",
    games: [fakeGame()],
    error: null,
  });
});

test("overview without Access settings still names the studio so the panel can embed it", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "game-studio", settings: { studioUrl: "https://studio.test" } });
  await plugin(bb);
  expect(await harness.callRpc("overview", {})).toMatchObject({
    studioUrl: "https://studio.test",
    games: null,
    error: expect.stringContaining("Access client ID"),
  });
});

test("nameThread records the thread on its game once", async () => {
  let named = 0;
  const studio = fakeStudio({
    "GET /api/games": () => ({ body: { games: [fakeGame({ threadId: named ? "thread" : null })] } }),
    "PATCH /api/games/game": ({ body }) => {
      named += 1;
      return { body: fakeGame({ threadId: (body as { threadId: string }).threadId }) };
    },
  });
  cleanups.push(studio.restore);
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    settings: STUDIO_SETTINGS,
    sdk: {
      threads: { get: async () => makeThreadResponse({ id: "thread", projectId: "project", environmentId: "env" }) },
      environments: { get: async () => ({ hostId: "remote", path: "/game" }) as never },
    },
  });
  await plugin(bb);
  expect(await harness.callRpc("nameThread", { gameId: "game", threadId: "thread" })).toEqual({
    game: fakeGame({ threadId: "thread" }),
  });
  await harness.callRpc("nameThread", { gameId: "game", threadId: "thread" });
  expect(named).toBe(1);
});
