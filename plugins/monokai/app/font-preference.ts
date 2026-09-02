import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

import type { uiFontRpcContract } from "../server.ts";
import { UI_FONT_STACKS, normalizeUiFont, type UiFont } from "../shared/ui-font.ts";

const UI_FONT_PROPERTY = "--bb-monokai-ui-font";
const REFRESH_DELAY_MS = 2_000;
const ACTIVE_MOUNT = Symbol.for("bb.monokai.ui-font.active-mount");

type FontPreferenceRegistry = typeof globalThis & {
  [ACTIVE_MOUNT]?: () => void;
};

interface RpcEnvelope {
  ok: boolean;
  result?: unknown;
}

interface FontSnapshot {
  uiFont: UiFont;
}

interface StyleTarget {
  getPropertyPriority(name: string): string;
  getPropertyValue(name: string): string;
  removeProperty(name: string): string;
  setProperty(name: string, value: string, priority?: string): void;
}

interface FontPreferenceDependencies {
  fetch: (input: string, init: RequestInit) => Promise<Pick<Response, "json" | "ok" | "status">>;
  style: StyleTarget;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function isFontSnapshot(value: unknown): value is FontSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.uiFont === "Inter (Default)" || record.uiFont === "SF Pro";
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const waitSignal = AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  if (waitSignal.aborted) return;
  await new Promise<void>((resolve) => {
    waitSignal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function getUiFont(
  pluginId: string,
  signal: AbortSignal,
  fetchImpl: FontPreferenceDependencies["fetch"],
): Promise<FontSnapshot> {
  const method = "getUiFont" satisfies keyof typeof uiFontRpcContract;
  const response = await fetchImpl(
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/${method}`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal,
    },
  );
  const envelope = (await response.json().catch(() => null)) as RpcEnvelope | null;
  if (!response.ok || !envelope?.ok || !isFontSnapshot(envelope.result)) {
    throw new Error(`Could not read the Monokai UI font (${response.status})`);
  }
  return envelope.result;
}

export function mountFontPreference(
  { pluginId, signal }: PluginContentScriptContext,
  dependencies: FontPreferenceDependencies = {
    fetch: globalThis.fetch.bind(globalThis),
    style: document.documentElement.style,
  },
): () => void {
  const registry = globalThis as FontPreferenceRegistry;
  registry[ACTIVE_MOUNT]?.();

  const previousValue = dependencies.style.getPropertyValue(UI_FONT_PROPERTY);
  const previousPriority = dependencies.style.getPropertyPriority(UI_FONT_PROPERTY);
  const wait = dependencies.sleep ?? sleep;
  const controller = new AbortController();
  let disposed = false;

  const restore = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", restore);
    controller.abort();
    if (registry[ACTIVE_MOUNT] === restore) delete registry[ACTIVE_MOUNT];
    if (previousValue.length === 0) {
      dependencies.style.removeProperty(UI_FONT_PROPERTY);
    } else {
      dependencies.style.setProperty(UI_FONT_PROPERTY, previousValue, previousPriority);
    }
  };

  signal.addEventListener("abort", restore, { once: true });
  registry[ACTIVE_MOUNT] = restore;

  void (async () => {
    while (!controller.signal.aborted) {
      try {
        const snapshot = await getUiFont(pluginId, controller.signal, dependencies.fetch);
        if (controller.signal.aborted) break;
        dependencies.style.setProperty(
          UI_FONT_PROPERTY,
          UI_FONT_STACKS[normalizeUiFont(snapshot.uiFont)],
        );
      } catch {
        // Keep the last applied font while bb reloads or briefly disconnects.
      }
      if (controller.signal.aborted) break;
      await wait(REFRESH_DELAY_MS, controller.signal);
    }
  })();

  return restore;
}
