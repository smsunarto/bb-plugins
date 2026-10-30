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
  /** `scheduled` while an edit waits for its pause, `sending` while its save is in flight. */
  save: "idle" | "scheduled" | "sending";
};

/** A draft that shows `stored` with nothing unsaved. */
function fresh(stored: RulesState): DraftSnapshot {
  return { base: stored, draft: stored.rules, conflict: null, error: null, save: "idle" };
}

/** What a store holds before anything was saved to it: nothing, at revision 0. */
const emptyDraft = () => fresh({ revision: 0, rules: [] });

/**
 * The editable copy of the rules. Edits autosave after a pause, one save at a
 * time, each naming the revision it was based on so it cannot delete rules
 * added elsewhere. It outlives the instructions page, so leaving the page never
 * drops a pending edit or a refused save.
 */
export function createRulesDraft({
  delayMs,
  onStored,
}: {
  delayMs: number;
  onStored: (state: RulesState) => void;
}) {
  let snapshot = emptyDraft();
  // The newest stored state seen from any source. Revisions only move forward.
  let newest: RulesState | null = null;
  let saveRules: SaveRules | null = null;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  function update(change: Partial<DraftSnapshot>) {
    snapshot = { ...snapshot, ...change };
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
    const { base, draft, conflict, save } = snapshot;
    if (draft !== base.rules || conflict !== null || save !== "idle") return;
    if (newest === null || newest.revision <= base.revision) return;
    snapshot = fresh(newest);
    notify();
  }
  function schedule() {
    clearTimeout(timer);
    const { base, draft, conflict, error, save } = snapshot;
    if (save === "sending") return;
    if (draft === base.rules || conflict !== null || error !== null) {
      if (save !== "idle") update({ save: "idle" });
      return;
    }
    timer = setTimeout(() => void send(), delayMs);
    update({ save: "scheduled" });
  }
  async function send() {
    const startedAt = epoch;
    const { base, draft } = snapshot;
    if (saveRules === null) return;
    update({ save: "sending" });
    try {
      const result = await saveRules({ rules: draft, revision: base.revision });
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
      if (snapshot.draft === draft) {
        update({ error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (startedAt === epoch) update({ save: "idle" });
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
      snapshot = emptyDraft();
      newest = null;
      saveRules = null;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    /**
     * The draft as the page should show it. The first stored rules a page
     * supplies become the base, so the page never renders before the draft
     * has them. Later fetches go through `receive`.
     */
    snapshotFor(server: RulesState): DraftSnapshot {
      if (newest === null) {
        newest = server;
        snapshot = fresh(server);
      }
      return snapshot;
    },
    /** The latest way to reach the server. Call on every render. */
    connect(next: SaveRules) {
      saveRules = next;
    },
    /**
     * Takes in stored rules from a fetch. Only a newer revision counts, so a
     * late or cached fetch never rolls back a save made since.
     */
    receive(stored: RulesState) {
      seen(stored);
      catchUp();
    },
    edit(rules: Rule[]) {
      update({ draft: rules, error: null });
      schedule();
    },
    /** Drop local edits and show the rules as stored. */
    takeTheirs() {
      const { conflict } = snapshot;
      if (conflict === null) return;
      update({ base: conflict, draft: conflict.rules, conflict: null });
      catchUp();
    },
    /** Keep local edits and save them over the stored rules. */
    keepMine() {
      const { base, conflict } = snapshot;
      if (conflict === null) return;
      update({ base: { ...base, revision: conflict.revision }, conflict: null });
      schedule();
    },
  };
}
