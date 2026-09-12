import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * bb's own list of folded thread rows. The built-in sidebar reads and writes
 * the same key, so a family folded in one sidebar is folded in the other, and
 * the fold survives a reload because bb persists the preference.
 */
export const COLLAPSED_THREADS_KEY = "sidebar.collapsedThreads";

type UiPreferences = Pick<BbPluginApi["sdk"]["system"]["uiPreferences"], "list" | "set">;

/** How many times a toggle re-reads after bb rejects its revision. */
const TOGGLE_ATTEMPTS = 3;

export function toggleThreadId(threadIds: readonly string[], threadId: string): string[] {
  return threadIds.includes(threadId)
    ? threadIds.filter((id) => id !== threadId)
    : [...threadIds, threadId];
}

export interface CollapsedThreadsStore {
  list(): Promise<string[]>;
  /** Folds an open family or opens a folded one; resolves to the new list. */
  toggle(threadId: string): Promise<string[]>;
}

/**
 * The preference's read and write, with bb's revision check honoured: `set`
 * carries the revision the read saw, and a rejected write (bb's own sidebar
 * wrote in between) re-reads and retries so neither side's fold is lost.
 */
export function createCollapsedThreadsStore(uiPreferences: UiPreferences): CollapsedThreadsStore {
  const read = async () => {
    const { preferences } = await uiPreferences.list();
    return preferences[COLLAPSED_THREADS_KEY];
  };
  return {
    async list() {
      return (await read()).value;
    },
    async toggle(threadId) {
      let lastError: unknown;
      for (let attempt = 0; attempt < TOGGLE_ATTEMPTS; attempt++) {
        const current = await read();
        try {
          const written = await uiPreferences.set({
            key: COLLAPSED_THREADS_KEY,
            expectedRevision: current.revision,
            value: toggleThreadId(current.value, threadId),
          });
          return written.value;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
  };
}
