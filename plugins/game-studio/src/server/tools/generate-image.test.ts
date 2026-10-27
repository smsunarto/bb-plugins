import { afterEach, expect, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { fakeGame, fakeStudio, STUDIO_SETTINGS } from "../../../test/fake-studio.ts";

type Approver = {
  pendingInteractions: readonly { id: string }[];
  submitInteraction(id: string, value: { approved: boolean; grantGame?: boolean }): void;
};
/** Answers every approval form the way a person would, while `action` runs. */
async function answering<T>(
  harness: Approver,
  answer: { approved: boolean; grantGame?: boolean },
  action: () => Promise<T>,
): Promise<T> {
  const answered = new Set<string>();
  const timer = setInterval(() => {
    for (const { id } of harness.pendingInteractions)
      if (!answered.has(id)) {
        answered.add(id);
        harness.submitInteraction(id, answer);
      }
  }, 2);
  try {
    return await action();
  } finally {
    clearInterval(timer);
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const job = (id: string, kind: string) => ({
  version: 1,
  id,
  threadId: "thread",
  createdAt: 1,
  updatedAt: 1,
  status: "queued",
  request: { kind, prompt: "x", model: { provider: "google", id: "gemini-nano-banana-2.1" } },
  outputs: [],
});
const payload = {
  gameId: "game",
  gameName: "Orbit",
  items: [
    {
      requestId: "req",
      title: "A moon icon",
      kind: "image",
      provider: "google",
      count: 1,
      retries: 0,
    },
  ],
};

function host() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    settings: STUDIO_SETTINGS,
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({ id: "thread", projectId: "project", environmentId: "environment" }),
      },
      environments: { get: async () => ({ hostId: "remote", path: "/game/" }) as never },
    },
  });
  return { bb, harness };
}

test("a generation the studio holds for approval is approved in the thread and submitted", async () => {
  let approved = 0;
  const studio = fakeStudio({
    "GET /api/games": () => ({ body: { games: [fakeGame()] } }),
    "POST /api/games/game/generations": () =>
      approved
        ? { body: { created: true, job: job("req", "image") } }
        : {
            status: 202,
            body: {
              approvalRequired: true,
              approvalId: "ask-1",
              payload,
              detail: "Approve first.",
            },
          },
    "POST /api/games/game/approvals": () => {
      approved += 1;
      return { body: { approved: 1, grant: null } };
    },
  });
  cleanups.push(studio.restore);
  const { bb, harness } = host();
  await plugin(bb);
  const result = JSON.parse(
    (await answering(harness, { approved: true, grantGame: true }, () =>
      harness.callAgentTool(
        "game_studio_generate_image",
        { gameId: "game", requestId: "req", prompt: "A moon icon" },
        { threadId: "thread" },
      ),
    )) as string,
  );
  expect(result).toMatchObject({ created: true, job: { id: "req", status: "queued" } });
  const paths = studio.calls.map((call) => `${call.method} ${call.path}`);
  // The thread is checked against the game again after the person answered, then the answer
  // is recorded and the request made once more.
  expect(paths).toEqual([
    "GET /api/games",
    "POST /api/games/game/generations",
    "GET /api/games",
    "POST /api/games/game/approvals",
    "POST /api/games/game/generations",
  ]);
  // Every call carries the Access service token; the agent never sees it.
  for (const call of studio.calls) {
    expect(call.headers.get("cf-access-client-id")).toBe("client-id.access");
    expect(call.headers.get("cf-access-client-secret")).toBe("client-secret");
  }
  expect(studio.calls[3]!.body).toEqual({
    approvalId: "ask-1",
    grantGame: true,
    threadId: "thread",
  });
  expect(studio.calls[4]!.body).toMatchObject({
    requestId: "req",
    threadId: "thread",
    request: { kind: "image", prompt: "A moon icon" },
  });
  expect(JSON.stringify(result)).not.toContain("client-secret");
});

test("a declined approval submits nothing and tells the agent why", async () => {
  const studio = fakeStudio({
    "GET /api/games": () => ({ body: { games: [fakeGame()] } }),
    "POST /api/games/game/generations": () => ({
      status: 202,
      body: { approvalRequired: true, approvalId: "ask-2", payload, detail: "Approve first." },
    }),
  });
  cleanups.push(studio.restore);
  const { bb, harness } = host();
  await plugin(bb);
  const result = JSON.parse(
    (await answering(harness, { approved: false }, () =>
      harness.callAgentTool(
        "game_studio_generate_image",
        { gameId: "game", requestId: "req", prompt: "A moon icon" },
        { threadId: "thread" },
      ),
    )) as string,
  );
  expect(result).toMatchObject({ declined: true, reason: "declined" });
  expect(studio.calls.filter((call) => call.path.endsWith("/approvals"))).toHaveLength(0);
});

test("a thread outside the game's checkout may not generate for it", async () => {
  const studio = fakeStudio({
    "GET /api/games": () => ({
      body: {
        games: [
          fakeGame({
            checkout: { projectId: "project", hostId: "remote", rootPath: "/elsewhere" },
          }),
        ],
      },
    }),
  });
  cleanups.push(studio.restore);
  const { bb, harness } = host();
  await plugin(bb);
  await expect(
    harness.callAgentTool(
      "game_studio_generate_image",
      { gameId: "game", requestId: "req", prompt: "A moon icon" },
      { threadId: "thread" },
    ),
  ).rejects.toThrow("Use a thread in the game's bb project and checkout.");
});

test("tools without the plugin's Access settings say what to set", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    settings: { studioUrl: "https://studio.test" },
  });
  await plugin(bb);
  await expect(
    harness.callAgentTool("game_studio_canvas_context", { gameId: "game" }, { threadId: "thread" }),
  ).rejects.toThrow("Set the Cloudflare Access client ID and secret");
});
