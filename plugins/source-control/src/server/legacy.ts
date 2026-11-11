/**
 * Whether the old `code-review` plugin still runs. Until the cutover disables
 * it, its watch and landed services, its tools and its `bb review` command
 * are the live ones, so Source Control's stand down: two watchers would wake
 * a thread twice, and two tools with one job confuse an agent. Read from bb's
 * plugin list on activation and again at most every half minute after a caller asks.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const LEGACY_PLUGIN = "code-review";
const STALE_MS = 30_000;

export function createLegacy(bb: BbPluginApi, now: () => number) {
  /** Assume it runs until the first answer: standing down a moment too long is harmless. */
  let running = true;
  let at = Number.NEGATIVE_INFINITY;
  let reading: Promise<boolean> | null = null;

  const refresh = (): Promise<boolean> => {
    reading ??= Promise.resolve()
      .then(() => bb.sdk.plugins.list())
      .then(
        (list) => {
          const entry = list.plugins.find((plugin) => plugin.id === LEGACY_PLUGIN);
          running = !!entry && entry.enabled && entry.status === "running";
          at = now();
          return running;
        },
        (error: unknown) => {
          bb.log.warn(`Could not read bb's plugin list: ${String(error)}`);
          return running;
        },
      )
      .finally(() => {
        reading = null;
      });
    return reading;
  };

  return {
    /** The last answer; asks again in the background once it is stale. */
    running(): boolean {
      if (now() - at > STALE_MS) void refresh();
      return running;
    },
    refresh,
  };
}

export type Legacy = ReturnType<typeof createLegacy>;
