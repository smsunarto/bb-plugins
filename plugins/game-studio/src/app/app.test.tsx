import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import type { Game } from "@argus-labs/game-studio-api";
import type { ExperimentalThreadActionTabProps, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";

installDom();
// Testing Library restores this flag after the first file that imports it; later files that call
// React's act directly need it to stay on.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { pluginQueryClient } = await import("@bb-kit/core/rpc/query");
const { act, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
const { studioRequests } = await import("./studio-requests.ts");
const { studioPageUrl } = await import("./studio-embed.tsx");
const app = await loadPluginApp(() => import("./app.tsx"));

beforeEach(() => pluginQueryClient.clear());
afterEach(() => {
  cleanup();
  pluginQueryClient.clear();
});

const game: Game = {
  id: "rampage",
  name: "Rampage",
  kind: "unity",
  createdAt: 1,
  threadId: "thread-main",
  previewPath: "index.html",
  checkout: { projectId: "project-rampage", hostId: "host-mac", rootPath: "/games/rampage" },
};
const overview = () => ({ studioUrl: "https://studio.test", games: [game], error: null });

describe("Game Studio registrations", () => {
  it("keeps the thread Studio tab id so saved tabs and layouts reopen", () => {
    expect(
      app.tabs.map(({ id, context, availability, layout }) => ({
        id,
        context,
        availability,
        layout,
      })),
    ).toEqual([
      { id: "studio", context: { kind: "thread" }, availability: "action", layout: "flush" },
    ]);
    expect(app.newThreadPanelActions.map((action) => action.id)).toEqual(["studio"]);
    expect(app.pendingInteractions.map((entry) => entry.id)).toEqual(["generation-approval"]);
    expect(app.composerCustomizations.map((entry) => entry.id)).toEqual(["studio-native-composer"]);
  });
});

describe("studio page urls", () => {
  it("opens a game's page or the gallery, marked as embedded", () => {
    expect(studioPageUrl("https://studio.test/", "a b")).toBe(
      "https://studio.test/games/a%20b?embed=1",
    );
    expect(studioPageUrl("https://studio.test", null)).toBe("https://studio.test/?embed=1");
  });
});

describe("thread Studio tab", () => {
  const tab = () => {
    const registration = app.tabs.find((entry) => entry.id === "studio");
    if (!registration) throw new Error("Missing the Studio tab");
    return { component: registration.component as ComponentType<ExperimentalThreadActionTabProps> };
  };

  it("embeds the thread's game and offers the studio in a tab", async () => {
    const slot = renderSlot(
      tab(),
      { threadId: "thread-main", params: null, projectId: game.checkout!.projectId } as never,
      { rpc: { overview } },
    );
    const link = (await slot.findByRole("link", { name: "Open" })) as HTMLAnchorElement;
    const frame = slot.container.querySelector("iframe");
    expect(frame?.src).toBe("https://studio.test/games/rampage?embed=1");
    expect(frame?.title).toBe("Rampage");
    expect(link.href).toBe("https://studio.test/games/rampage");
    expect(link.target).toBe("_blank");
  });

  it("embeds the gallery for a thread without a game and warns when tools are off", async () => {
    const slot = renderSlot(
      tab(),
      { threadId: "thread-other", params: null, projectId: null } as never,
      {
        rpc: {
          overview: () => ({
            studioUrl: "https://studio.test",
            games: null,
            error: "Set the Cloudflare Access client ID and secret.",
          }),
        },
      },
    );
    expect((await slot.findByRole("alert")).textContent).toContain("Access client ID and secret");
    expect(slot.container.querySelector("iframe")?.src).toBe("https://studio.test/?embed=1");
  });
});

describe("thread Info Game row", () => {
  const row = () => {
    const registration = app.threadInfoRows.find((entry) => entry.id === "studio-game");
    if (!registration) throw new Error("Missing the Game info row");
    return registration;
  };

  it("names the thread's game and opens it in the Studio tab", async () => {
    const slot = renderSlot(
      row(),
      { threadId: "thread-main", projectId: game.checkout!.projectId, environment: null },
      { rpc: { overview } },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Rampage" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "openThreadPanel", options: { actionId: "studio", params: { gameId: "rampage" } } },
    ]);
  });

  it("matches a thread working in the game's checkout", async () => {
    const thread = {
      id: "thread-side",
      projectId: game.checkout!.projectId,
      host: { id: game.checkout!.hostId },
      environment: { path: "/games/rampage/" },
    } as unknown as PluginSidebarThread;
    const slot = renderSlot(
      row(),
      { threadId: "thread-side", projectId: game.checkout!.projectId, environment: null },
      { rpc: { overview }, sidebarThreads: { threads: [thread] } },
    );
    expect(await slot.findByRole("button", { name: "Rampage" })).toBeTruthy();
  });

  it("shows nothing for a thread without a game", async () => {
    const slot = renderSlot(
      row(),
      { threadId: "thread-other", projectId: game.checkout!.projectId, environment: null },
      { rpc: { overview } },
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toContain("overview");
    expect(slot.queryByRole("button")).toBeNull();
  });
});

describe("studio requests in the composer", () => {
  const banner = () => {
    const customization = app.composerCustomizations.find(
      (entry) => entry.id === "studio-native-composer",
    );
    const registration = customization?.banners?.[0];
    if (!registration) throw new Error("Missing the composer banner");
    return registration;
  };
  const request = {
    prompt: "Implement the jump.",
    request: { id: "req_1", action: "build", createdAt: 1, path: "canvas/requests/req_1.json" },
    input: { gameId: "rampage", action: "build", documentId: "design" },
  };

  it("names the thread on the game, then appends the prompt and its pill", async () => {
    const named: unknown[] = [];
    const slot = renderSlot(
      banner(),
      {},
      {
        pluginId: "game-studio",
        rpc: {
          overview,
          nameThread: (input: unknown) => {
            named.push(input);
            return { game };
          },
        },
        composer: { scope: { kind: "thread", threadId: "thread-main" }, text: "Context first.  " },
      },
    );
    await act(async () => {
      studioRequests.post({ threadId: "thread-main", ...request });
    });
    await waitFor(() => expect(slot.inspection.composer.draft.mentions).toHaveLength(1));
    expect(named).toEqual([{ gameId: "rampage", threadId: "thread-main" }]);
    const { text, mentions } = slot.inspection.composer.draft;
    const [mention] = mentions;
    const pill = mention ? text.slice(mention.from, mention.to) : "";
    expect(pill).toContain("Game Studio · build");
    expect(text).toBe(`Context first.\n\nImplement the jump. ${pill} `);
    expect(mentions).toEqual([
      {
        from: "Context first.\n\nImplement the jump. ".length,
        to: "Context first.\n\nImplement the jump. ".length + pill.length,
        label: "Game Studio · build",
        kind: "plugin",
        pluginId: "game-studio",
        provider: "request",
        id: JSON.stringify({ ...request.input, request: request.request }),
        icon: null,
      },
    ]);
    expect(slot.inspection.composer.focusCount).toBe(1);
  });

  it("selects the game's checkout for a new thread", async () => {
    const slot = renderSlot(
      banner(),
      {},
      {
        pluginId: "game-studio",
        rpc: { overview },
        composer: { scope: { kind: "new-thread", projectId: null } },
      },
    );
    await act(async () => {
      studioRequests.post({ threadId: null, ...request });
    });
    await waitFor(() => expect(slot.inspection.composer.draft.mentions).toHaveLength(1));
    expect(slot.inspection.composer.selections).toEqual([
      {
        projectId: "project-rampage",
        environment: {
          type: "host",
          hostId: "host-mac",
          workspace: { type: "unmanaged", path: "/games/rampage" },
        },
      },
    ]);
    expect(slot.inspection.composer.draft.text).toMatch(
      /^Implement the jump\. \S.*Game Studio · build $/,
    );
  });

  it("leaves another thread's requests alone", async () => {
    const slot = renderSlot(
      banner(),
      {},
      {
        pluginId: "game-studio",
        rpc: { overview },
        composer: { scope: { kind: "thread", threadId: "thread-other" } },
      },
    );
    await act(async () => {
      studioRequests.post({ threadId: "thread-main", ...request });
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(slot.inspection.composer.draft.text).toBe("");
    expect(studioRequests.take("thread-main")).toHaveLength(1);
  });
});
