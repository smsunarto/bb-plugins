import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store.ts";

/**
 * GenUI gives its instructions and `check_ui` only to threads a person reads.
 * It reads `audience` from its own metadata namespace, and a spawn seeds only
 * the spawner's, so the mark is a separate write under GenUI's id.
 */
const GENUI_PLUGIN_ID = "genui";

function writeMark(bb: Pick<BbPluginApi, "sdk">, threadId: string) {
  return bb.sdk.threads.updatePluginMetadata({
    threadId,
    pluginId: GENUI_PLUGIN_ID,
    set: { audience: "person" },
  });
}

function warning(threadId: string, error: unknown): string {
  return `${threadId} not marked person-facing for GenUI: ${(error as Error).message}`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

/** Mark a Captain's thread person-facing for GenUI. Returns a warning instead of failing. */
export async function markPersonFacing(
  bb: Pick<BbPluginApi, "sdk">,
  threadId: string,
): Promise<string | null> {
  try {
    await writeMark(bb, threadId);
    return null;
  } catch (error) {
    return warning(threadId, error);
  }
}

/**
 * Mark every live Captain, for Captains started before the mark existed.
 * A Captain whose thread was deleted outside `archive` is skipped quietly.
 * Crew threads are not Captains, so their replies stay agent-facing.
 */
export async function markCaptainsPersonFacing(
  bb: Pick<BbPluginApi, "sdk">,
  store: Pick<Store, "liveCaptains">,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const captain of store.liveCaptains()) {
    try {
      await writeMark(bb, captain.threadId);
    } catch (error) {
      if (!isNotFound(error)) warnings.push(warning(captain.threadId, error));
    }
  }
  return warnings;
}
