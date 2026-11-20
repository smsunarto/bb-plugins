import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isNotFound } from "./audience.ts";
import { NOTICE, type Store } from "./store.ts";

/** The title Captains were started with before their sidebar icon marked them. */
function suffixedTitle(name: string): string {
  return `${name} Captain`;
}

/**
 * Rename each live Captain titled "<name> Captain" to its name, once. A title
 * the user changed is left alone, and so is one changed back after this ran:
 * the check is recorded per Captain. Returns warnings instead of failing.
 */
export async function dropTitleSuffixes(
  bb: Pick<BbPluginApi, "sdk">,
  store: Pick<Store, "liveCaptains" | "noticeSentAt" | "markNoticeSent">,
  now: () => number,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const captain of store.liveCaptains()) {
    const key = NOTICE.titleSuffix(captain.threadId);
    if (store.noticeSentAt(key) !== null) continue;
    try {
      const thread = await bb.sdk.threads.get({ threadId: captain.threadId });
      if (thread.title === suffixedTitle(captain.name)) {
        await bb.sdk.threads.update({ threadId: captain.threadId, title: captain.name });
      }
      store.markNoticeSent(key, now());
    } catch (error) {
      if (isNotFound(error)) store.markNoticeSent(key, now());
      else warnings.push(`${captain.threadId} title not checked: ${(error as Error).message}`);
    }
  }
  return warnings;
}
