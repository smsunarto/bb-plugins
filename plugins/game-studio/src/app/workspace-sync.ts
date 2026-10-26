import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import {
  workspaceChanged,
  workspaceChangedChannel,
  type CanvasChange,
} from "../shared/canvas-contract.ts";
import type { Workspace } from "../shared/schema.ts";
import { rpc } from "./rpc.ts";

/** The workspace an open studio holds, with the fingerprint the server gave it. */
export type HeldWorkspace = Workspace & { fingerprint?: string };

/** Changes reach an open studio over realtime; this read only covers a missed signal. */
export const SAFETY_POLL_MS = 60_000;

/**
 * Whether the studio already shows this file as it is now: its own save, or
 * a read that raced the signal. Anything it cannot tell is news.
 */
export function holdsChange(workspace: Workspace, change: CanvasChange): boolean {
  if (change.sha256 === null) return false;
  if (change.path === "canvas/index.json") return workspace.indexRevision === change.sha256;
  const board = /^canvas\/(boards|editor)\/([a-zA-Z0-9_-]{1,100})\.json$/.exec(change.path);
  if (board) {
    const entry = workspace.boards.find((item) => item.board.id === board[2]);
    if (!entry) return false;
    try {
      const revision = JSON.parse(entry.revision) as { content?: unknown; layout?: unknown };
      return (board[1] === "boards" ? revision.content : revision.layout) === change.sha256;
    } catch {
      return false;
    }
  }
  const document = /^canvas\/documents\/([a-zA-Z0-9_-]{1,100})\.md$/.exec(change.path);
  if (document)
    return workspace.documents.some(
      (item) => item.id === document[1] && item.revision === change.sha256,
    );
  return false;
}

/** The workspace after a board save the studio made, without reading it again. */
export function withSavedBoard(
  held: HeldWorkspace,
  board: Workspace["boards"][number]["board"],
  revision: string,
): HeldWorkspace {
  return {
    ...held,
    // It no longer matches the fingerprint the server gave, so the next read sends everything.
    fingerprint: undefined,
    boards: held.boards.map((entry) =>
      entry.board.id === board.id ? { ...entry, board, revision } : entry,
    ),
  };
}

/**
 * Where an open studio keeps its synced workspace: its own key, not `get`'s,
 * whose plain workspaces carry no fingerprint and no watch lease.
 */
export function syncKey(gameId: string) {
  return ["game-studio", "workspace-sync", { gameId }] as const;
}

/**
 * The workspace an open studio shows, kept current by push instead of
 * polling. The host says when the canvas changes on disk and BB says when a
 * run this plugin started stops; the studio reads again then, on a
 * reconnect, and on a slow safety poll. Each read sends the fingerprint the
 * studio holds, so an unchanged workspace is never shipped twice.
 *
 * A board save hands back its revision, which the studio keeps instead of
 * reading the workspace again. The host's signal for that save names the
 * same file and hash, so it is not news either. A save that fails reads the
 * disk, and the canvas rebases its draft onto the newer board.
 */
export function useStudioWorkspace(gameId: string) {
  const client = rpc.useClient();
  const queryClient = useQueryClient();
  const key = syncKey(gameId);
  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<HeldWorkspace> => {
      const held = queryClient.getQueryData<HeldWorkspace>(key);
      for (const since of held?.fingerprint ? [held.fingerprint, undefined] : [undefined]) {
        const synced = await client.syncWorkspace({ gameId, ...(since ? { since } : {}) });
        if (synced.status === "changed")
          return { ...synced.workspace, fingerprint: synced.fingerprint };
        // The cache may have dropped what the fingerprint stood for meanwhile.
        const current = queryClient.getQueryData<HeldWorkspace>(key);
        if (current?.fingerprint === synced.fingerprint) return current;
      }
      throw new Error("Project unavailable. Reload the workspace.");
    },
    refetchInterval: SAFETY_POLL_MS,
    retry: false,
  });
  const refetch = useRef(query.refetch);
  refetch.current = query.refetch;
  const pulling = useRef({ running: false, again: false });
  /** Reads again; a change heard while a read runs gets one more read after it. */
  const pull = useCallback(() => {
    const state = pulling.current;
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    void (async () => {
      try {
        do {
          state.again = false;
          // A read already running may have started before the change; this one starts after it.
          await refetch.current();
        } while (state.again);
      } finally {
        state.running = false;
      }
    })();
  }, []);
  const saving = useRef<Promise<unknown> | null>(null);
  useRealtime(workspaceChangedChannel, (payload) => {
    const parsed = workspaceChanged.safeParse(payload);
    if (!parsed.success) return;
    const signal = parsed.data;
    if ("threadId" in signal) {
      const held = queryClient.getQueryData<HeldWorkspace>(key);
      if (held?.generationJobs.some((job) => job.taskId === signal.threadId)) pull();
      return;
    }
    if (signal.gameId !== gameId) return;
    void (async () => {
      // A save still in flight decides once it hands back its revision.
      await saving.current?.catch(() => undefined);
      const held = queryClient.getQueryData<HeldWorkspace>(key);
      if (!held || !signal.changes?.every((change) => holdsChange(held, change))) pull();
    })();
  });
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    const was = previous.current;
    previous.current = connection;
    // Signals sent while the connection was down are lost. The first connect is not a reconnect.
    if (was === "reconnecting" && connection === "connected") pull();
  }, [connection, pull]);
  const saveBoard = useCallback(
    async (board: Workspace["boards"][number]["board"], revision: string) => {
      const pending = client.saveBoard({ gameId, board, revision });
      saving.current = pending;
      try {
        const result = await pending;
        const workspaceKey = syncKey(gameId);
        const racing = queryClient.isFetching({ queryKey: workspaceKey }) > 0;
        queryClient.setQueryData<HeldWorkspace>(workspaceKey, (workspace) =>
          workspace ? withSavedBoard(workspace, board, result.revision) : workspace,
        );
        // A read that started before this save would hand back the board without it.
        if (racing) void refetch.current();
        return result;
      } catch (error) {
        // Read the disk even after a conflict: the canvas rebases its draft onto the newer board.
        await refetch.current();
        throw error;
      } finally {
        if (saving.current === pending) saving.current = null;
      }
    },
    [client, gameId, queryClient],
  );
  return { query, saveBoard };
}
