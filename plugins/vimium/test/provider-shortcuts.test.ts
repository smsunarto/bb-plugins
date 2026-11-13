import "./helpers/dom.ts";
import "./helpers/bb-keybindings.ts";
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { mountLinkHints } from "../src/app/link-hints.ts";
import {
  readFavorites,
  setProviderShortcuts,
  shortcutSelection,
  targetProvider,
  type Favorite,
} from "../src/app/provider-shortcuts.ts";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

type Model = Awaited<ReturnType<PluginBrowserBbSdk["providers"]["models"]>>["models"][number];
const model = (id: string): Model => ({
  id,
  model: id,
  displayName: id,
  description: "",
  isDefault: false,
  defaultReasoningEffort: "high",
  supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({
    reasoningEffort,
    description: "",
  })),
  supportedServiceTiers: [{ id: "fast" }, { id: "ultrafast" }],
  reasoningDiscovery: "known",
});

afterEach(() => {
  setProviderShortcuts(null);
  document.body.innerHTML = "";
});

for (const [source, target, providerId] of [
  ["gpt-6-astra", "claude-fable-5-1", "codex"],
  ["gpt-6.1-sol", "claude-opus-5-5", "codex"],
  ["claude-fable-5-1", "gpt-6-astra", "claude-code"],
  ["claude-opus-5-5", "gpt-6.1-sol", "claude-code"],
])
  test(`${source} switches to ${target}`, () => {
    expect(
      shortcutSelection(
        "provider",
        { providerId, model: source, reasoningLevel: "high", serviceTier: "fast" },
        [model("other"), model(target!)],
      ),
    ).toEqual({
      providerId: providerId === "codex" ? "claude-code" : "codex",
      model: target,
      reasoningLevel: "high",
      serviceTier: "fast",
    });
  });

const fav = (providerId: string, model: string): Favorite => ({ providerId, model });

test("favorites come from t3-composer's per-device list and skip malformed keys", () => {
  const storage = {
    getItem: () =>
      JSON.stringify(["codex\u0000gpt-6-astra", "bad", 3, "claude-code\u0000claude-opus-5-5"]),
  };
  expect(readFavorites(storage)).toEqual([
    fav("codex", "gpt-6-astra"),
    fav("claude-code", "claude-opus-5-5"),
  ]);
  expect(readFavorites({ getItem: () => "not json" })).toEqual([]);
  expect(readFavorites(undefined)).toEqual([]);
});

test("the favorite model cycle steps through this provider's favorites and wraps", () => {
  const models = [model("gpt-6-astra"), model("gpt-6.1-sol"), model("gpt-6-mini")];
  const favorites = [
    fav("codex", "gpt-6-astra"),
    fav("claude-code", "claude-opus-5-5"),
    fav("codex", "gpt-6.1-sol"),
  ];
  const next = (current: string) =>
    shortcutSelection("model", { providerId: "codex", model: current }, models, favorites);
  expect(next("gpt-6-astra")).toEqual({ model: "gpt-6.1-sol" });
  expect(next("gpt-6.1-sol")).toEqual({ model: "gpt-6-astra" });
  // Off the list, the first favorite; a lone favorite has nowhere to go.
  expect(next("gpt-6-mini")).toEqual({ model: "gpt-6-astra" });
  expect(
    shortcutSelection("model", { providerId: "codex", model: "gpt-6-astra" }, models, [
      fav("codex", "gpt-6-astra"),
    ]),
  ).toBeNull();
});

test("the favorite provider cycle visits providers with favorites, at the same model size", () => {
  const favorites = [
    fav("codex", "gpt-6-astra"),
    fav("claude-code", "claude-opus-5-5"),
    fav("pi", "pi-large"),
  ];
  expect(targetProvider({ providerId: "codex" }, favorites)).toBe("claude-code");
  expect(targetProvider({ providerId: "claude-code" }, favorites)).toBe("pi");
  expect(targetProvider({ providerId: "pi" }, favorites)).toBe("codex");
  // Fewer than two providers with favorites: Codex and Claude Code swap.
  expect(targetProvider({ providerId: "codex" }, [fav("codex", "gpt-6-astra")])).toBe(
    "claude-code",
  );
  // Sol is Opus-sized, so it lands on Opus even though Fable is also offered.
  expect(
    shortcutSelection(
      "provider",
      { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high" },
      [model("claude-fable-5-1"), model("claude-opus-5-5")],
      favorites,
    ),
  ).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5" });
  // With no same-size model, the target's first favorite.
  expect(
    shortcutSelection(
      "provider",
      { providerId: "claude-code", model: "claude-opus-5-5" },
      [model("pi-small"), model("pi-large")],
      favorites,
    ),
  ).toMatchObject({ providerId: "pi", model: "pi-large" });
});

test("effort steps up and down and stops at the ends", () => {
  const models = [model("test")];
  const step = (action: "reasoning-up" | "reasoning-down", reasoningLevel?: string) =>
    shortcutSelection(action, { model: "test", reasoningLevel }, models);
  expect(step("reasoning-up", "low")).toEqual({ reasoningLevel: "medium" });
  expect(step("reasoning-down", "medium")).toEqual({ reasoningLevel: "low" });
  expect(step("reasoning-up", "high")).toBeNull();
  expect(step("reasoning-down", "low")).toBeNull();
  // No level chosen yet: start from the model's default, high.
  expect(step("reasoning-down")).toEqual({ reasoningLevel: "medium" });
});

test("reasoning and speed cycle with wrap and omit unsupported tiers", () => {
  const models = [model("test")];
  expect(shortcutSelection("reasoning", { model: "test", reasoningLevel: "high" }, models)).toEqual(
    { reasoningLevel: "low" },
  );
  expect(shortcutSelection("reasoning", { model: "test", reasoningLevel: "low" }, models)).toEqual({
    reasoningLevel: "medium",
  });
  for (const [serviceTier, next] of [
    ["default", "fast"],
    ["fast", "ultrafast"],
    ["ultrafast", "default"],
  ]) {
    expect(shortcutSelection("speed", { model: "test", serviceTier }, models)).toEqual({
      serviceTier: next,
    });
  }
  expect(
    shortcutSelection("speed", { model: "test", serviceTier: "fast" }, [
      { ...models[0]!, supportedServiceTiers: [{ id: "fast" }] },
    ]),
  ).toEqual({ serviceTier: "default" });
  expect(
    shortcutSelection("speed", { model: "test" }, [
      { ...models[0]!, supportedServiceTiers: undefined },
    ]),
  ).toBeNull();
  expect(
    shortcutSelection("provider", { providerId: "codex", model: "gpt-6-astra" }, []),
  ).toBeNull();
});

const press = (key: string, target: EventTarget = window, repeat = false) =>
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, repeat, bubbles: true, cancelable: true }),
  );

test("Escape sequences work while editing, suppress repeats, and cancel on another key or click", () => {
  const controller = new window.AbortController();
  const dispose = mountLinkHints({ pluginId: "vimium", generation: 1, signal: controller.signal });
  document.body.innerHTML = "<div data-app-composer><textarea></textarea></div>";
  const editor = document.querySelector("textarea")!;
  const actions: string[] = [];
  setProviderShortcuts((action) => {
    actions.push(action);
    return true;
  });
  for (const key of ["m", "r", ";"]) {
    expect(press(key, editor)).toBe(true);
    press("Escape", editor);
    expect(press(key, editor)).toBe(false);
    expect(press(key, editor, true)).toBe(false);
  }
  expect(actions).toEqual(["provider", "reasoning", "speed"]);
  press("Escape", editor);
  expect(press("f", editor)).toBe(true);
  expect(actions).toHaveLength(3);
  press("Escape", editor);
  press("x", editor);
  press("m", editor);
  press("Escape", editor);
  editor.click();
  press("r", editor);
  expect(actions).toHaveLength(3);
  void dispose();
  controller.abort();
});

test("registered SDK overlay applies model pairing to the real composer handle", async () => {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const slot = renderSlot(
    app.appOverlays.find(({ id }) => id === "thread-navigation")!,
    {},
    {
      composer: {
        scope: { kind: "new-thread", projectId: null },
        selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
      },
      sdk: {
        providers: {
          models: async () => ({
            modelLoadError: null,
            permissionCeiling: "full",
            providers: [],
            selectedOnlyModels: [],
            models: [model("claude-fable-5-1")],
          }),
        },
      },
    },
  );
  const controller = new window.AbortController();
  const dispose = mountLinkHints({ pluginId: "vimium", generation: 1, signal: controller.signal });
  await act(async () => {
    press("Escape");
    press("m");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(slot.inspection.composer.selections).toEqual([
    {
      providerId: "claude-code",
      model: "claude-fable-5-1",
      reasoningLevel: "high",
      serviceTier: "default",
    },
  ]);
  slot.lifecycle.unmount();
  void dispose();
  controller.abort();
});

test("F8 from inside the composer steps to the next favorite model through bb's binding", async () => {
  window.localStorage.setItem(
    "bb-plugin:t3-composer:model-favorites",
    JSON.stringify(["codex\u0000gpt-6-astra", "codex\u0000gpt-6.1-sol"]),
  );
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const slot = renderSlot(
    app.appOverlays.find(({ id }) => id === "thread-navigation")!,
    {},
    {
      composer: {
        scope: { kind: "new-thread", projectId: null },
        selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
      },
      sdk: {
        providers: {
          models: async () => ({
            modelLoadError: null,
            permissionCeiling: "full",
            providers: [],
            selectedOnlyModels: [],
            models: [model("gpt-6-astra"), model("gpt-6.1-sol")],
          }),
        },
      },
    },
  );
  const controller = new window.AbortController();
  const dispose = mountLinkHints({ pluginId: "vimium", generation: 1, signal: controller.signal });
  document.body.insertAdjacentHTML(
    "beforeend",
    "<div data-app-composer><textarea></textarea></div>",
  );
  const editor = document.querySelector("textarea")!;
  await act(async () => {
    expect(press("F8", editor)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  // A plain letter in the same field is still typing.
  expect(press("n", editor)).toBe(true);
  expect(slot.inspection.composer.selections).toEqual([{ model: "gpt-6.1-sol" }]);
  window.localStorage.removeItem("bb-plugin:t3-composer:model-favorites");
  slot.lifecycle.unmount();
  void dispose();
  controller.abort();
});

test("late provider discovery cannot write after leaving the composer", async () => {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  let resolveModels:
    | ((value: Awaited<ReturnType<PluginBrowserBbSdk["providers"]["models"]>>) => void)
    | undefined;
  const catalog = new Promise<Awaited<ReturnType<PluginBrowserBbSdk["providers"]["models"]>>>(
    (resolve) => {
      resolveModels = resolve;
    },
  );
  const slot = renderSlot(
    app.appOverlays.find(({ id }) => id === "thread-navigation")!,
    {},
    {
      composer: {
        scope: { kind: "new-thread", projectId: null },
        selection: {
          providerId: "codex",
          model: "gpt-6-astra",
          environment: {
            type: "host",
            hostId: "host_test",
            workspace: { type: "unmanaged", path: null },
          },
        },
      },
      sdk: { providers: { models: async () => catalog } },
    },
  );
  const controller = new window.AbortController();
  const dispose = mountLinkHints({ pluginId: "vimium", generation: 1, signal: controller.signal });
  press("Escape");
  press("m");
  slot.lifecycle.unmount();
  resolveModels?.({
    modelLoadError: null,
    permissionCeiling: "full",
    providers: [],
    selectedOnlyModels: [],
    models: [model("claude-fable-5-1")],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(slot.inspection.composer.selections).toEqual([]);
  void dispose();
  controller.abort();
});

test("reasoning uses retained model capabilities on the selected provider machine", async () => {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const calls: Parameters<PluginBrowserBbSdk["providers"]["models"]>[0][] = [];
  const slot = renderSlot(
    app.appOverlays.find(({ id }) => id === "thread-navigation")!,
    {},
    {
      composer: {
        scope: { kind: "new-thread", projectId: "proj_test" },
        selection: {
          projectId: "proj_test",
          providerId: "claude-code",
          model: "opus[1m]",
          reasoningLevel: "medium",
          environment: {
            type: "provider",
            environmentProviderId: "checkout",
            inputs: null,
            machine: { type: "existing", hostId: "host_remote" },
          },
        },
      },
      sdk: {
        providers: {
          models: async (args) => {
            calls.push(args);
            return {
              modelLoadError: null,
              permissionCeiling: "full",
              providers: [],
              selectedOnlyModels: [model("opus[1m]")],
              models: [model("claude-opus-5-5")],
            };
          },
        },
      },
    },
  );
  const controller = new window.AbortController();
  const dispose = mountLinkHints({ pluginId: "vimium", generation: 1, signal: controller.signal });
  await act(async () => {
    press("Escape");
    press("r");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(calls[0]).toMatchObject({
    hostId: "host_remote",
    projectId: "proj_test",
    providerId: "claude-code",
  });
  expect(slot.inspection.composer.selections).toEqual([{ reasoningLevel: "high" }]);
  slot.lifecycle.unmount();
  void dispose();
  controller.abort();
});

test("terminal and unrelated text inputs retain Escape commands", () => {
  const controller = new window.AbortController();
  const dispose = mountLinkHints({ pluginId: "vimium", generation: 1, signal: controller.signal });
  document.body.innerHTML =
    '<div class="xterm"><textarea></textarea></div><input aria-label="Rename">';
  const actions: string[] = [];
  setProviderShortcuts((action) => {
    actions.push(action);
    return true;
  });
  for (const input of document.querySelectorAll("textarea, input")) {
    for (const key of [";", "r", "m"]) {
      press("Escape", input);
      expect(press(key, input)).toBe(true);
    }
  }
  expect(actions).toEqual([]);
  void dispose();
  controller.abort();
});

test("focused split composer wins over the primary route", async () => {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const calls: string[] = [];
  const slot = renderSlot(
    app.appOverlays.find(({ id }) => id === "thread-navigation")!,
    {},
    {
      context: { projectId: "proj_test", threadId: "thr_primary" },
      composer: {
        scope: { kind: "thread", threadId: "thr_child" },
        selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "medium" },
      },
      sidebarSplitLayout: {
        panes: [
          {
            paneId: "pane_primary",
            threadId: "thr_primary",
            isFocused: false,
            rect: { x: 0, y: 0, width: 0.5, height: 1 },
          },
          {
            paneId: "pane_child",
            threadId: "thr_child",
            isFocused: true,
            rect: { x: 0.5, y: 0, width: 0.5, height: 1 },
          },
        ],
      },
      sdk: {
        threads: {
          get: async ({ threadId }) => {
            calls.push(threadId);
            const { makeThreadResponse } = await import("@get-bb/plugin-sdk/testing");
            return makeThreadResponse({ id: threadId, environmentId: "env_child" });
          },
        },
        providers: {
          models: async () => ({
            modelLoadError: null,
            permissionCeiling: "full",
            providers: [],
            selectedOnlyModels: [],
            models: [model("gpt-6-astra")],
          }),
        },
      },
    },
  );
  const controller = new window.AbortController();
  const dispose = mountLinkHints({ pluginId: "vimium", generation: 1, signal: controller.signal });
  await act(async () => {
    press("Escape");
    press("r");
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  expect(calls).toEqual(["thr_child"]);
  expect(slot.inspection.composer.selections).toEqual([{ reasoningLevel: "high" }]);
  slot.lifecycle.unmount();
  void dispose();
  controller.abort();
});

test("focused non-thread split leaves an unfocused new-thread composer alone", async () => {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const slot = renderSlot(
    app.appOverlays.find(({ id }) => id === "thread-navigation")!,
    {},
    {
      composer: {
        scope: { kind: "new-thread", projectId: null },
        selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "medium" },
      },
      sidebarSplitLayout: {
        panes: [
          {
            paneId: "new",
            threadId: null,
            isFocused: false,
            rect: { x: 0, y: 0, width: 0.5, height: 1 },
          },
          {
            paneId: "plugin",
            threadId: null,
            isFocused: true,
            rect: { x: 0.5, y: 0, width: 0.5, height: 1 },
          },
        ],
      },
    },
  );
  const controller = new window.AbortController();
  const dispose = mountLinkHints({ pluginId: "vimium", generation: 1, signal: controller.signal });
  press("Escape");
  press("r");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(slot.inspection.composer.selections).toEqual([]);
  slot.lifecycle.unmount();
  void dispose();
  controller.abort();
});
