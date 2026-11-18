import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store.ts";

/**
 * GenUI gives its instructions and `check_ui` only to threads a person reads.
 * It reads `audience` from its own metadata namespace, and a spawn seeds only
 * the spawner's, so the mark is a separate write under GenUI's id.
 */
const GENUI_PLUGIN_ID = "genui";

/** Mark a Captain's thread person-facing for GenUI. Returns a warning instead of failing. */
export async function markPersonFacing(
  bb: Pick<BbPluginApi, "sdk">,
  threadId: string,
): Promise<string | null> {
  try {
    await bb.sdk.threads.updatePluginMetadata({
      threadId,
      pluginId: GENUI_PLUGIN_ID,
      set: { audience: "person" },
    });
    return null;
  } catch (error) {
    return `${threadId} not marked person-facing for GenUI: ${(error as Error).message}`;
  }
}

/**
 * Mark every live Captain, for Captains started before the mark existed.
 * Crew threads are not Captains, so their replies stay agent-facing.
 */
export async function markCaptainsPersonFacing(
  bb: Pick<BbPluginApi, "sdk">,
  store: Pick<Store, "liveCaptains">,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const captain of store.liveCaptains()) {
    const warning = await markPersonFacing(bb, captain.threadId);
    if (warning !== null) warnings.push(warning);
  }
  return warnings;
}
