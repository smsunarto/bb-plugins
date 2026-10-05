import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CHANNELS, type SettingsPayload } from "../../shared/contracts/channels.ts";
import type { WhiteboardSettings } from "../../shared/contracts/engine.ts";

/**
 * The plugin settings (design §3.4). Labels and descriptions are upstream's
 * Desktop settings page (`settings-page.tsx:247-269`), in its order, saying
 * Whiteboards where upstream says sessions. Both default to false: upstream
 * Desktop's Software Map default is
 * `review.experimental.softwareMap.enabled: false`
 * (`reviewConfiguration.ts:49-52`), and its scratchpad preference defaults
 * to false (`review-preferences.ts`).
 */
export const SETTING_DESCRIPTORS = {
  softwareMapEnabled: {
    type: "boolean",
    label: "Software Map",
    description: "Show the experimental Software Map view in Whiteboards.",
    default: false,
  },
  scratchpadEnabled: {
    type: "boolean",
    label: "Scratchpad",
    description:
      "Show the experimental scratchpad on Home. Agents draw on it through Whiteboard's MCP tools.",
    default: false,
  },
} as const;

/**
 * The scratchpad setting changes the `whiteboard_session_get_instructions`
 * description, which is fixed at registration, so a change reloads the
 * plugin after this quiet period. Tool lists reach agents at their next
 * session start.
 */
export const RELOAD_DEBOUNCE_MS = 500;

const DEFAULTS: SettingsPayload = { scratchpadEnabled: false, softwareMapEnabled: false };

const loads = new WeakMap<WhiteboardSettings, Promise<void>>();

/**
 * Resolves once `settings` holds the stored values (immediately for settings
 * not made by `createSettings`). Never rejects: a failed read keeps the
 * defaults.
 */
export function whenSettingsLoaded(settings: WhiteboardSettings): Promise<void> {
  return loads.get(settings) ?? Promise.resolve();
}

function pick(values: Partial<SettingsPayload>): SettingsPayload {
  return {
    scratchpadEnabled: values.scratchpadEnabled === true,
    softwareMapEnabled: values.softwareMapEnabled === true,
  };
}

function report(bb: BbPluginApi, message: string): void {
  try {
    bb.log.warn(`whiteboard: ${message}`);
  } catch {
    // A disposed plugin's logger throws; there is nobody left to tell.
  }
}

/**
 * Declare the settings and keep a synchronous view of them for the engine and
 * the tool catalog. On a change it notifies subscribers, publishes
 * `whiteboard:settings` (the panels re-read `/capabilities` and `info`), and,
 * when the scratchpad flips, schedules one `plugins.reload` of this plugin.
 * The reload is debounced, fire-and-forget and never reentrant: bb runs
 * `onChange` listeners synchronously inside the settings write, with no
 * lifecycle lock held.
 */
export function createSettings(bb: BbPluginApi): WhiteboardSettings {
  const handle = bb.settings.define(SETTING_DESCRIPTORS);
  let current: SettingsPayload = DEFAULTS;
  let changed = false;
  let disposed = false;
  let reloadTimer: NodeJS.Timeout | undefined;
  let reloading = false;
  const listeners = new Set<(next: SettingsPayload, previous: SettingsPayload) => void>();

  const reload = () => {
    reloadTimer = undefined;
    if (disposed || reloading) return;
    reloading = true;
    bb.sdk.plugins
      .reload({ pluginId: bb.pluginId })
      .catch((error: unknown) => {
        if (!disposed) report(bb, `reload after the scratchpad change failed: ${String(error)}`);
      })
      .finally(() => {
        reloading = false;
      });
  };

  handle.onChange((nextValues, previousValues) => {
    if (disposed) return;
    changed = true;
    const next = pick(nextValues);
    const previous = pick(previousValues);
    current = next;
    for (const listener of listeners) {
      try {
        listener(next, previous);
      } catch (error) {
        report(bb, `a settings listener failed: ${String(error)}`);
      }
    }
    try {
      bb.realtime.publish(CHANNELS.settings, next);
    } catch (error) {
      report(bb, `publishing ${CHANNELS.settings} failed: ${String(error)}`);
    }
    if (next.scratchpadEnabled !== previous.scratchpadEnabled) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(reload, RELOAD_DEBOUNCE_MS);
      reloadTimer.unref?.();
    }
  });

  bb.onDispose(() => {
    disposed = true;
    clearTimeout(reloadTimer);
    listeners.clear();
  });

  const settings: WhiteboardSettings = {
    scratchpadEnabled: () => current.scratchpadEnabled,
    softwareMapEnabled: () => current.softwareMapEnabled,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const load = async () => {
    try {
      const values = await handle.get();
      // A change that raced ahead of the first read is newer; keep it.
      if (!changed) current = pick(values);
    } catch (error) {
      report(bb, `reading settings failed, using defaults: ${String(error)}`);
    }
  };
  loads.set(settings, load());
  return settings;
}
