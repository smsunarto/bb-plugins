import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import type { ComposerSelection, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { Game } from "../shared/schema.ts";

installDom();
// Testing Library restores this flag after the first file that imports it; later files that call
// React's act directly need it to stay on.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { pluginQueryClient } = await import("@bb-kit/core/rpc/query");
const { act, cleanup, fireEvent } = await import("@testing-library/react");
const { useComposer } = await import("@get-bb/plugin-sdk/app");
const { appendStudioRequest, selectedAgent } = await import("./studio-composer.ts");
const app = await loadPluginApp(() => import("./app.tsx"));

beforeEach(() => pluginQueryClient.clear());
afterEach(() => {
  cleanup();
  pluginQueryClient.clear();
});

const game: Game = {
  id: "rampage",
  name: "Rampage",
  projectId: "project-rampage",
  hostId: "host-mac",
  rootPath: "/games/rampage",
  kind: "unity",
  createdAt: 1,
  threadId: "thread-main",
  previewPath: "index.html",
};
const overview = () => ({ games: [game], hosts: [], projects: [] });

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
      { threadId: "thread-main", projectId: game.projectId, environment: null },
      { rpc: { overview } },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Rampage" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "openThreadPanel", options: { actionId: "studio" } },
    ]);
  });

  it("matches a thread working in the game's checkout", async () => {
    const thread = {
      id: "thread-side",
      projectId: game.projectId,
      host: { id: game.hostId },
      environment: { path: "/games/rampage/" },
    } as unknown as PluginSidebarThread;
    const slot = renderSlot(
      row(),
      { threadId: "thread-side", projectId: game.projectId, environment: null },
      { rpc: { overview }, sidebarThreads: { threads: [thread] } },
    );
    expect(await slot.findByRole("button", { name: "Rampage" })).toBeTruthy();
  });

  it("shows nothing for a thread without a game", async () => {
    const slot = renderSlot(
      row(),
      { threadId: "thread-other", projectId: game.projectId, environment: null },
      { rpc: { overview } },
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toContain("overview");
    expect(slot.queryByRole("button")).toBeNull();
  });
});

describe("Studio composer requests", () => {
  function RequestButton({ prompt }: { prompt: string }) {
    const composer = useComposer();
    return (
      <button
        onClick={() =>
          appendStudioRequest(composer, prompt, {
            id: '{"action":"build"}',
            label: "Studio · build",
          })
        }
      >
        Prepare
      </button>
    );
  }

  it("appends the prompt and its request pill on a new paragraph", async () => {
    const slot = renderSlot(
      { component: RequestButton },
      { prompt: "Implement the jump." },
      {
        pluginId: "game-studio",
        composer: { scope: { kind: "thread", threadId: "thread-main" }, text: "Context first.  " },
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Prepare" }));
    const { text, mentions } = slot.inspection.composer.draft;
    const [mention] = mentions;
    // The host serializes the pill's text; the request rides on the pill, not on that text.
    const pill = mention ? text.slice(mention.from, mention.to) : "";
    expect(pill).toContain("Studio · build");
    expect(text).toBe(`Context first.\n\nImplement the jump. ${pill} `);
    expect(mentions).toEqual([
      {
        from: "Context first.\n\nImplement the jump. ".length,
        to: "Context first.\n\nImplement the jump. ".length + pill.length,
        label: "Studio · build",
        kind: "plugin",
        pluginId: "game-studio",
        provider: "request",
        id: '{"action":"build"}',
        icon: null,
      },
    ]);
    expect(slot.inspection.composer.focusCount).toBe(1);
  });

  it("starts an empty draft with the prompt", async () => {
    const slot = renderSlot(
      { component: RequestButton },
      { prompt: "Playtest the level." },
      { composer: { scope: { kind: "new-thread", projectId: null } } },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Prepare" }));
    const { text, mentions } = slot.inspection.composer.draft;
    expect(text).toMatch(/^Playtest the level\. \S.*Studio · build $/);
    expect(mentions.map(({ from }) => from)).toEqual(["Playtest the level. ".length]);
  });
});

describe("composer agent selection", () => {
  it("keeps the picked model's own reasoning level and service tier", () => {
    const selection: ComposerSelection = {
      providerId: "codex",
      model: "gpt-6.1-sol",
      reasoningLevel: "ultracode",
      serviceTier: "ultrafast",
    };
    expect(selectedAgent(selection, "high")).toEqual({
      providerId: "codex",
      model: "gpt-6.1-sol",
      reasoningLevel: "ultracode",
      serviceTier: "ultrafast",
    });
  });

  it("waits for a picked provider and model", () => {
    expect(selectedAgent(null, "high")).toBeUndefined();
    expect(selectedAgent({ providerId: "codex" }, "high")).toBeUndefined();
    expect(selectedAgent({ providerId: "codex", model: "gpt-6" }, "high")).toEqual({
      providerId: "codex",
      model: "gpt-6",
      reasoningLevel: "high",
    });
  });
});
