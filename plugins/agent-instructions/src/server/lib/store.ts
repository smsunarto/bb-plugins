import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  compose,
  rulesSchema,
  rulesStateSchema,
  type Rule,
  type RulesState,
  type Session,
} from "../../shared/rules.ts";

const STORAGE_KEY = "state";

export type RuleStore = {
  /** Reads persisted rules. Call once before agents resolve. */
  load(): Promise<void>;
  state(): RulesState;
  /** Read-modify-write in one queued step, so concurrent edits never drop each other. */
  update(change: (rules: Rule[]) => Rule[]): Promise<RulesState>;
  /** Replaces every rule, unless something else wrote since `revision`. */
  save(rules: Rule[], revision: number): Promise<RulesState & { saved: boolean }>;
  /**
   * Composes a thread's instructions and remembers the session it was
   * composed for. Synchronous, because bb resolves it on the thread-start path.
   */
  resolve(threadId: string, session: Session): string | null;
  /** The last session `resolve` saw for a thread since this plugin loaded. */
  lastSession(threadId: string): Session | undefined;
};

/** What every RPC handler and command receives: the host plus the rule store. */
export type AgentInstructionsContext = Readonly<{ bb: BbPluginApi; store: RuleStore }>;

const REMEMBERED_SESSIONS = 200;

export function openStore(bb: BbPluginApi): RuleStore {
  let current: RulesState = { revision: 0, rules: [] };
  const sessions = new Map<string, Session>();
  // Writes run one at a time in call order.
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  }
  async function commit(rules: Rule[]): Promise<RulesState> {
    const next = { revision: current.revision + 1, rules: rulesSchema.parse(rules) };
    await bb.storage.kv.set(STORAGE_KEY, next);
    current = next;
    return next;
  }
  return {
    async load() {
      const stored = rulesStateSchema.safeParse(
        (await bb.storage.kv.get(STORAGE_KEY)) ?? { revision: 0, rules: [] },
      );
      if (stored.success) current = stored.data;
      else bb.log.warn(`ignoring unreadable stored rules: ${stored.error.message}`);
    },
    state: () => current,
    update: (change) => serialized(() => commit(change(current.rules))),
    save: (rules, revision) =>
      serialized(async () =>
        revision === current.revision
          ? { ...(await commit(rules)), saved: true }
          : { ...current, saved: false },
      ),
    resolve(threadId, session) {
      sessions.delete(threadId);
      sessions.set(threadId, session);
      if (sessions.size > REMEMBERED_SESSIONS) {
        sessions.delete(sessions.keys().next().value ?? threadId);
      }
      return compose(current.rules, session);
    },
    lastSession: (threadId) => sessions.get(threadId),
  };
}
