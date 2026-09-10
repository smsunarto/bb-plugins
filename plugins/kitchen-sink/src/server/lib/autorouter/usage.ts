import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Unknown usage never authorizes Opus as a Fable fallback. */
export async function availableRoutesForUsage(
  bb: BbPluginApi,
  hostId: string,
  enabled: ReadonlySet<string>,
): Promise<Set<string>> {
  const routes = new Set(enabled);
  if (![...routes].some((id) => id.startsWith("opus/") || id.startsWith("fable/"))) return routes;
  let fableExhausted = false;
  let opusExhausted = false;
  try {
    const usage = (await bb.sdk.system.usageLimits({ hostId, providerId: "claude-code" }))[
      "claude-code"
    ];
    if (usage?.status === "ok") {
      const exhausted = usage.windows.filter(
        (window) =>
          window.usedPercent >= 100 &&
          (!window.resetsAt || Date.parse(window.resetsAt) > Date.now()),
      );
      fableExhausted = exhausted.some((window) => /\bfable\b/i.test(window.label));
      opusExhausted = exhausted.some((window) => /\bopus\b/i.test(window.label));
    }
  } catch (error) {
    bb.log.warn(`autorouter usage unavailable: ${String(error)}`);
  }
  for (const id of routes) {
    if (
      (id.startsWith("opus/") && (!fableExhausted || opusExhausted)) ||
      (id.startsWith("fable/") && fableExhausted)
    )
      routes.delete(id);
  }
  return routes;
}
