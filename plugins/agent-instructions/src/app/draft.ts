import type { Rule, RulesState } from "../shared/rules.ts";

export type SaveRules = (input: {
  rules: Rule[];
  revision: number;
}) => Promise<RulesState & { saved: boolean }>;

export type DraftSnapshot = {
  /** The stored state the draft is based on. `draft === base.rules` means nothing is unsaved. */
  base: RulesState;
  draft: Rule[];
  /** What is stored, after a save was refused because it was based on an old revision. */
  conflict: RulesState | null;
  error: string | null;
};

/**
 * The editable copy of the rules. Edits autosave after a pause, one save at a
 * time, each naming the revision it was based on so it cannot delete rules
 * added elsewhere. It outlives the settings page, so leaving the page never
 * drops a pending edit or a refused save.
 */
export function createRulesDraft({
  delayMs,
  onStored,
}: {
  delayMs: number;
  onStored: (state: RulesState) => void;
}) {
  let snapshot: DraftSnapshot | null = null;
  // The newest stored state seen from any source. Revisions only move forward.
  let newest: RulesState | null = null;
  let save: SaveRules | null = null;
  let sending = false;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  function current(): DraftSnapshot {
    if (snapshot === null) throw new Error("rules draft read before it received the stored rules");
    return snapshot;
  }
  function update(change: Partial<DraftSnapshot>) {
    snapshot = { ...current(), ...change };
    notify();
  }
  function notify() {
    for (const listener of listeners) listener();
  }
  function seen(stored: RulesState) {
    if (newest === null || stored.revision > newest.revision) newest = stored;
  }
  /** Shows the newest stored rules when nothing here is unsaved. */
  function catchUp() {
    const { base, draft, conflict } = current();
    if (draft !== base.rules || conflict !== null || sending) return;
    if (newest === null || newest.revision <= base.revision) return;
    snapshot = { base: newest, draft: newest.rules, conflict: null, error: null };
    notify();
  }
  function schedule() {
    clearTimeout(timer);
    const { base, draft, conflict, error } = current();
    if (draft === base.rules || conflict !== null || error !== null || sending) return;
    timer = setTimeout(() => void send(), delayMs);
  }
  async function send() {
    const startedAt = epoch;
    const { base, draft } = current();
    if (save === null) return;
    sending = true;
    try {
      const result = await save({ rules: draft, revision: base.revision });
      if (startedAt !== epoch) return;
      if (result.saved) {
        const stored = { revision: result.revision, rules: draft };
        seen(stored);
        update({ base: stored });
        onStored(stored);
      } else {
        const stored = { revision: result.revision, rules: result.rules };
        seen(stored);
        update({ conflict: stored });
      }
    } catch (error) {
      if (startedAt !== epoch) return;
      // A newer edit may already fix what failed, so it saves instead.
      if (current().draft === draft) {
        update({ error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (startedAt === epoch) sending = false;
    }
    if (startedAt !== epoch) return;
    catchUp();
    schedule();
  }

  return {
    /** Reset between isolated previews/tests, after all consumers have unmounted. */
    resetForTest() {
      epoch++;
      clearTimeout(timer);
      timer = undefined;
      snapshot = null;
      newest = null;
      save = null;
      sending = false;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    /** The latest way to reach the server. Call on every render. */
    connect(next: SaveRules) {
      save = next;
    },
    /**
     * Takes in stored rules from a fetch. Only a newer revision counts, so a
     * late or cached fetch never rolls back a save made since.
     */
    receive(stored: RulesState) {
      seen(stored);
      if (snapshot === null) {
        snapshot = { base: stored, draft: stored.rules, conflict: null, error: null };
        notify();
      }
      catchUp();
    },
    edit(rules: Rule[]) {
      update({ draft: rules, error: null });
      schedule();
    },
    /** Drop local edits and show the rules as stored. */
    takeTheirs() {
      const { conflict } = current();
      if (conflict === null) return;
      update({ base: conflict, draft: conflict.rules, conflict: null });
      catchUp();
    },
    /** Keep local edits and save them over the stored rules. */
    keepMine() {
      const { base, conflict } = current();
      if (conflict === null) return;
      update({ base: { ...base, revision: conflict.revision }, conflict: null });
      schedule();
    },
  };
}
