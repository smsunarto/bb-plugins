import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { agentSelection, type AgentSelection } from "../../shared/generation.ts";
import type { PendingRun } from "../../shared/schema.ts";

/*
 * A run that waits for its inputs is the server's own record, not part of the board: the
 * board is a document under autosave and three-way merge, where scheduler state would race
 * with edits. One row per node holds the run's identity until it dispatches or is cancelled,
 * so two runs that need the same input wait for one generation of it.
 */

type Db = ReturnType<BbPluginApi["storage"]["database"]>;
export type HeldRun = {
  gameId: string;
  boardId: string;
  nodeId: string;
  requestId: string;
  /** The requesting thread, which must still own a registered checkout when the run dispatches. */
  threadId: string | null;
  /** The BB agent for text and agent steps that pin none themselves. */
  agent: AgentSelection | null;
  batch: number;
  requestedAt: number;
  error: string | null;
};
type Row = {
  game: string;
  board: string;
  node: string;
  request: string;
  thread: string | null;
  agent: string | null;
  batch: number;
  requested: number;
  error: string | null;
};

const table = "studio_canvas_runs";

export class CanvasRunStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      game TEXT NOT NULL, board TEXT NOT NULL, node TEXT NOT NULL, request TEXT NOT NULL,
      thread TEXT, agent TEXT, batch INTEGER NOT NULL, requested INTEGER NOT NULL, error TEXT,
      PRIMARY KEY (game, board, node))`);
  }
  private static run(row: Row): HeldRun {
    const parsed = row.agent ? agentSelection.safeParse(JSON.parse(row.agent)) : undefined;
    return {
      gameId: row.game,
      boardId: row.board,
      nodeId: row.node,
      requestId: row.request,
      threadId: row.thread,
      agent: parsed?.success ? parsed.data : null,
      batch: row.batch,
      requestedAt: row.requested,
      error: row.error,
    };
  }
  /** Holds a run for the node, replacing one it already holds: the newer intent wins. */
  hold(run: Omit<HeldRun, "error" | "requestedAt"> & { requestedAt?: number }) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${table} (game, board, node, request, thread, agent, batch, requested, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        run.gameId,
        run.boardId,
        run.nodeId,
        run.requestId,
        run.threadId,
        run.agent ? JSON.stringify(run.agent) : null,
        run.batch,
        run.requestedAt ?? Date.now(),
      );
  }
  get(gameId: string, boardId: string, nodeId: string): HeldRun | undefined {
    const row = this.db
      .prepare(`SELECT * FROM ${table} WHERE game = ? AND board = ? AND node = ?`)
      .get(gameId, boardId, nodeId) as Row | undefined;
    return row && CanvasRunStore.run(row);
  }
  list(gameId: string): HeldRun[] {
    return (
      this.db
        .prepare(`SELECT * FROM ${table} WHERE game = ? ORDER BY requested, node`)
        .all(gameId) as Row[]
    ).map(CanvasRunStore.run);
  }
  /** Games with held runs, for a restarted server to drive on. */
  games(): string[] {
    return (this.db.prepare(`SELECT DISTINCT game FROM ${table}`).all() as { game: string }[]).map(
      (row) => row.game,
    );
  }
  /** Drops the node's held run; with a request id, only that run. */
  release(gameId: string, boardId: string, nodeId: string, requestId?: string): boolean {
    const result = requestId
      ? this.db
          .prepare(`DELETE FROM ${table} WHERE game = ? AND board = ? AND node = ? AND request = ?`)
          .run(gameId, boardId, nodeId, requestId)
      : this.db
          .prepare(`DELETE FROM ${table} WHERE game = ? AND board = ? AND node = ?`)
          .run(gameId, boardId, nodeId);
    return result.changes > 0;
  }
  fail(gameId: string, boardId: string, nodeId: string, error: string) {
    this.db
      .prepare(`UPDATE ${table} SET error = ? WHERE game = ? AND board = ? AND node = ?`)
      .run(error.slice(0, 2000), gameId, boardId, nodeId);
  }
  /** The held runs of a game by board and node, as a workspace read shows them. */
  pending(gameId: string): Record<string, Record<string, PendingRun>> {
    const result: Record<string, Record<string, PendingRun>> = {};
    for (const run of this.list(gameId)) {
      result[run.boardId] ??= {};
      result[run.boardId]![run.nodeId] = {
        requestId: run.requestId,
        requestedAt: run.requestedAt,
        ...(run.error ? { error: run.error } : {}),
      };
    }
    return result;
  }
}
