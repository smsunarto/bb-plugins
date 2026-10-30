import { useEffect, useSyncExternalStore } from "react";
import type { Proposal } from "./proposals.js";

export interface DocumentSnapshot {
  content: string;
  sha256: string;
  proposal: Proposal | null;
  previewBaseUrl: string;
  previewPath: string;
}

export type ProposalAction = "accept" | "reject" | "undo" | "redo";

export interface DocumentWriter {
  renamesToTitle: boolean;
  save(
    path: string,
    content: string,
    expectedSha256: string,
    renameToTitle: boolean,
  ): Promise<{ path: string; sha256: string }>;
  updateProposal?(path: string, content: string, version: number): Promise<Proposal>;
  resolveProposal?(path: string, action: ProposalAction, version: number): Promise<Proposal>;
  refetch(): Promise<void>;
}

/** The document as the page shows it. `dirty` means the draft differs from what `base` shows. */
export interface DocumentContent {
  base: DocumentSnapshot;
  draft: string;
  dirty: boolean;
}

type Mode =
  /** Edits autosave. */
  | { mode: "editing"; saving: boolean; conflict: DocumentSnapshot | null }
  /** A proposal action is in flight. A read that lands meanwhile waits in `held`. */
  | { mode: "resolving"; held: DocumentSnapshot | null }
  /** The action landed; reads older than this proposal version are ignored. */
  | { mode: "awaiting"; version: number };

type Phase<Content> =
  | { phase: "loading" }
  /**
   * The document cannot be read. `last` is what the page showed before, so it
   * can stay visible and be copied; it is null when nothing ever loaded.
   */
  | {
      phase: "unavailable";
      reason: "missing" | "unknown-vault" | "error";
      message: string;
      last: Content | null;
    }
  /** `error` is the last failed read, save, or proposal action, cleared by a retry or a good read. */
  | ({ phase: "loaded"; error: string | null } & Content & Mode);

export type DocumentState = { path: string } & Phase<DocumentContent>;

/** A state whose `dirty` the session fills in, shown or retained. */
type Uncommitted = { path: string } & Phase<Omit<DocumentContent, "dirty">>;

/** The document to show, if any was ever read. */
export function contentOf(state: DocumentState): DocumentContent | null {
  if (state.phase === "loaded") return state;
  return state.phase === "unavailable" ? state.last : null;
}

const RESOLVE_TIMEOUT_MS = 5_000;
const READ_CONFIRMATION_MS = 5_000;
const MAX_PENDING_READ_IDENTITIES = 32;
let nextSessionId = 0;

function identity(snapshot: DocumentSnapshot): string {
  return JSON.stringify([
    snapshot.sha256,
    snapshot.proposal?.version ?? null,
    snapshot.proposal?.status ?? null,
  ]);
}

function unavailableReason(message: string): "missing" | "unknown-vault" | "error" {
  if (/unknown vault/i.test(message)) return "unknown-vault";
  return /\bENOENT\b|path does not exist|not found|no such file/i.test(message)
    ? "missing"
    : "error";
}

export function createDocumentSession(options: {
  path: string;
  showsProposals: boolean;
  delay: number;
  onRename?(from: string, to: string): void;
}) {
  let state: DocumentState = { path: options.path, phase: "loading" };
  const listeners = new Set<() => void>();
  const pendingReadIdentities = new Map<string, number>();
  let readConfirmationTimer: ReturnType<typeof setTimeout> | null = null;
  let writer: DocumentWriter | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> | null = null;
  let inFlight: string | null = null;
  let awaitTimer: ReturnType<typeof setTimeout> | null = null;

  const shown = (snapshot: DocumentSnapshot) =>
    options.showsProposals && snapshot.proposal?.status === "pending"
      ? snapshot.proposal.content
      : snapshot.content;
  const filled = (content: Omit<DocumentContent, "dirty">): DocumentContent => ({
    ...content,
    dirty: content.draft !== shown(content.base),
  });
  const commit = (next: Uncommitted) => {
    // The autosave and resolve timers belong to the modes that start them.
    if (timer && (next.phase !== "loaded" || next.mode !== "editing")) {
      clearTimeout(timer);
      timer = null;
    }
    if (awaitTimer && (next.phase !== "loaded" || next.mode !== "awaiting")) {
      clearTimeout(awaitTimer);
      awaitTimer = null;
    }
    state =
      next.phase === "loaded"
        ? { ...next, ...filled(next) }
        : next.phase === "unavailable"
          ? { ...next, last: next.last && filled(next.last) }
          : next;
    for (const listener of listeners) listener();
  };
  const clearReadConfirmation = () => {
    pendingReadIdentities.clear();
    if (readConfirmationTimer) clearTimeout(readConfirmationTimer);
    readConfirmationTimer = null;
  };
  const recordLocalWrite = (base: DocumentSnapshot, next: DocumentSnapshot) => {
    const now = Date.now();
    for (const [key, until] of pendingReadIdentities)
      if (until <= now) pendingReadIdentities.delete(key);
    pendingReadIdentities.set(identity(base), now + READ_CONFIRMATION_MS);
    pendingReadIdentities.delete(identity(next));
    while (pendingReadIdentities.size > MAX_PENDING_READ_IDENTITIES)
      pendingReadIdentities.delete(pendingReadIdentities.keys().next().value!);
    if (readConfirmationTimer) clearTimeout(readConfirmationTimer);
    readConfirmationTimer = setTimeout(() => {
      readConfirmationTimer = null;
      pendingReadIdentities.clear();
      void writer?.refetch();
    }, READ_CONFIRMATION_MS);
  };
  /**
   * Shows the result of a write that landed. While the document is unavailable
   * it goes into `last`, so a restore does not resend the hash the write replaced.
   */
  const landed = (from: DocumentSnapshot, next: DocumentSnapshot, path: string) => {
    recordLocalWrite(from, next);
    const current = state;
    if (current.phase === "loaded") commit({ ...current, path, base: next, error: null });
    else if (current.phase === "unavailable" && current.last)
      commit({ ...current, path, last: { ...current.last, base: next } });
  };
  /** Shows `snapshot` with nothing unsaved. A save loop already running keeps going. */
  const adopt = (snapshot: DocumentSnapshot) => {
    const saving = state.phase === "loaded" && state.mode === "editing" && state.saving;
    commit({
      path: state.path,
      phase: "loaded",
      base: snapshot,
      draft: shown(snapshot),
      mode: "editing",
      saving,
      conflict: null,
      error: null,
    });
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush(false);
    }, options.delay);
  };

  const receive = (snapshot: DocumentSnapshot) => {
    const current = state;
    const content = contentOf(current);
    if (content === null) return adopt(snapshot);
    const { base } = content;
    if (identity(snapshot) === identity(base)) {
      clearReadConfirmation();
      const refreshed = { ...base, previewBaseUrl: snapshot.previewBaseUrl };
      if (current.phase !== "loaded")
        return commit({
          path: current.path,
          phase: "loaded",
          base: refreshed,
          draft: content.draft,
          mode: "editing",
          saving: false,
          conflict: null,
          error: null,
        });
      if (snapshot.previewBaseUrl !== base.previewBaseUrl || current.error !== null)
        commit({ ...current, base: refreshed, error: null });
      return;
    }
    const pendingUntil = pendingReadIdentities.get(identity(snapshot));
    if (pendingUntil !== undefined && pendingUntil > Date.now()) return;
    if (current.phase === "loaded" && current.mode === "awaiting") {
      if ((snapshot.proposal?.version ?? 0) < current.version) return;
      return adopt(snapshot);
    }
    if (current.phase === "loaded" && current.mode === "resolving")
      return commit({ ...current, held: snapshot });
    if (inFlight !== null && shown(snapshot) === inFlight) return;
    clearReadConfirmation();
    const settled =
      current.phase === "loaded"
        ? !current.dirty && !current.saving && current.conflict === null
        : !content.dirty;
    if (settled || shown(snapshot) === content.draft) return adopt(snapshot);
    commit({
      path: current.path,
      phase: "loaded",
      base,
      draft: content.draft,
      mode: "editing",
      saving: current.phase === "loaded" && current.saving,
      conflict: snapshot,
      error: null,
    });
  };

  const receiveError = (message: string | null) => {
    const current = state;
    if (message === null) {
      if (current.phase === "unavailable")
        commit(
          current.last
            ? {
                path: current.path,
                phase: "loaded",
                ...current.last,
                mode: "editing",
                saving: false,
                conflict: null,
                error: null,
              }
            : { path: current.path, phase: "loading" },
        );
      else if (current.phase === "loaded" && current.error !== null)
        commit({ ...current, error: null });
      return;
    }
    const reason = unavailableReason(message);
    // A failed read of a loaded document is retryable; editing and proposal actions go on.
    if (reason === "error" && current.phase === "loaded")
      return commit({ ...current, error: message });
    const content = contentOf(current);
    commit({
      path: current.path,
      phase: "unavailable",
      reason,
      message,
      last: content && { base: content.base, draft: content.draft },
    });
  };

  const save = async (drain: boolean) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!writer || state.phase !== "loaded" || state.mode !== "editing") return;
    commit({ ...state, saving: true });
    try {
      for (;;) {
        const current = state;
        if (current.phase !== "loaded" || current.mode !== "editing") return;
        if (!current.dirty || current.conflict !== null) return;
        const { base, draft: content } = current;
        inFlight = content;
        const pending =
          options.showsProposals && base.proposal?.status === "pending" ? base.proposal : null;
        try {
          if (pending && writer.updateProposal) {
            const proposal = await writer.updateProposal(current.path, content, pending.version);
            landed(base, { ...base, proposal }, state.path);
          } else {
            const result = await writer.save(
              current.path,
              content,
              base.sha256,
              writer.renamesToTitle,
            );
            const from = state.path;
            landed(
              base,
              {
                ...base,
                content,
                sha256: result.sha256,
                previewPath: result.path === from ? base.previewPath : result.path,
              },
              result.path,
            );
            if (result.path !== from) options.onRename?.(from, result.path);
          }
          if (!drain && state.phase === "loaded" && state.dirty) {
            schedule();
            return;
          }
        } catch (error) {
          const failed = state;
          if (failed.phase !== "loaded" || failed.mode !== "editing") return;
          if (failed.base !== base) continue;
          if (failed.conflict !== null) return;
          commit({ ...failed, error: error instanceof Error ? error.message : String(error) });
          void writer.refetch();
          return;
        }
      }
    } finally {
      inFlight = null;
      if (state.phase === "loaded" && state.mode === "editing") commit({ ...state, saving: false });
    }
  };

  const flush = (drain = true): Promise<void> => {
    if (saving)
      return drain
        ? saving.then(() => (state.phase === "loaded" && state.dirty ? flush(true) : undefined))
        : saving;
    saving = save(drain).finally(() => {
      saving = null;
    });
    return saving;
  };

  return {
    id: `document-${(nextSessionId += 1)}`,
    getSnapshot: () => state,
    hasSubscribers: () => listeners.size > 0,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect(next: DocumentWriter) {
      writer = next;
    },
    receive,
    receiveError,
    flush,
    edit(draft: string) {
      if (state.phase !== "loaded" || state.mode !== "editing" || draft === state.draft) return;
      commit({ ...state, draft });
      if (state.conflict === null) schedule();
    },
    keepMine() {
      if (state.phase !== "loaded" || state.mode !== "editing" || state.conflict === null) return;
      commit({ ...state, base: state.conflict, conflict: null });
      return flush();
    },
    useTheirs() {
      if (state.phase === "loaded" && state.mode === "editing" && state.conflict)
        adopt(state.conflict);
    },
    retry() {
      receiveError(null);
      void writer?.refetch();
      return flush();
    },
    async resolve(action: ProposalAction) {
      if (!writer?.resolveProposal) return;
      await flush();
      const current = state;
      if (current.phase !== "loaded" || current.mode !== "editing") return;
      const proposal = current.base.proposal;
      if (!proposal || current.conflict || current.dirty) return;
      const { base, draft, path } = current;
      commit({ path, phase: "loaded", base, draft, mode: "resolving", held: null, error: null });
      try {
        const result = await writer.resolveProposal(path, action, proposal.version);
        const resolving = state;
        // A read error took the document away meanwhile; its next read decides.
        if (resolving.phase !== "loaded" || resolving.mode !== "resolving") return;
        commit({ ...resolving, mode: "awaiting", version: result.version });
        if (resolving.held) receive(resolving.held);
        if (state.phase === "loaded" && state.mode === "awaiting")
          awaitTimer = setTimeout(() => {
            awaitTimer = null;
            void writer?.refetch();
          }, RESOLVE_TIMEOUT_MS);
      } catch (error) {
        const resolving = state;
        if (resolving.phase !== "loaded" || resolving.mode !== "resolving") return;
        commit({
          ...resolving,
          mode: "editing",
          saving: false,
          conflict: null,
          error: error instanceof Error ? error.message : String(error),
        });
        if (resolving.held) receive(resolving.held);
      }
    },
  };
}

export type DocumentSession = ReturnType<typeof createDocumentSession>;

const sessions = new Map<string, DocumentSession>();
const renamedFrom = new Map<string, { session: DocumentSession; until: number }>();
export const MAX_IDLE_SESSIONS = 20;
const RENAME_ALIAS_MS = 10_000;

/** No unsaved draft, shown or kept while unavailable, and no save in flight. */
function idle(state: DocumentState): boolean {
  if (contentOf(state)?.dirty) return false;
  return !(state.phase === "loaded" && state.mode === "editing" && state.saving);
}

export function documentSession(
  key: (path: string) => string,
  path: string,
  options: { showsProposals: boolean; delay: number },
): DocumentSession {
  const existing = sessions.get(key(path));
  if (existing) {
    for (const [alias, entry] of renamedFrom)
      if (entry.session === existing) renamedFrom.delete(alias);
    sessions.delete(key(path));
    sessions.set(key(path), existing);
    return existing;
  }
  const alias = renamedFrom.get(key(path));
  if (alias && alias.until > Date.now()) return alias.session;
  renamedFrom.delete(key(path));
  const session = createDocumentSession({
    ...options,
    path,
    onRename(from, to) {
      if (sessions.get(key(from)) === session) sessions.delete(key(from));
      sessions.set(key(to), session);
      renamedFrom.set(key(from), {
        session,
        until: Date.now() + RENAME_ALIAS_MS,
      });
    },
  });
  sessions.set(key(path), session);
  for (const [cachedKey, cached] of sessions) {
    if (sessions.size <= MAX_IDLE_SESSIONS) break;
    if (cached !== session && !cached.hasSubscribers() && idle(cached.getSnapshot()))
      sessions.delete(cachedKey);
  }
  return session;
}

export function useDocumentSession(
  session: DocumentSession,
  sources: {
    snapshot: DocumentSnapshot | undefined;
    error: string | null;
    writer: DocumentWriter;
  },
): DocumentState {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  session.connect(sources.writer);
  const { snapshot, error } = sources;
  useEffect(() => {
    if (snapshot) session.receive(snapshot);
  }, [session, snapshot]);
  useEffect(() => {
    session.receiveError(error);
  }, [session, error]);
  useEffect(
    () => () => {
      void session.flush();
    },
    [session],
  );
  return state;
}
