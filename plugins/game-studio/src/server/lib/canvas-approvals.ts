import type { BbPluginApi } from "@get-bb/plugin-sdk";

/*
 * What the person approved for a request lineage: how many generations it may make, counting
 * its batch and the retries its review may add. Rows exist only for runs an agent started;
 * a run from the canvas UI has none and is unrestricted. Rows survive restarts with the held
 * runs they cover, so a retry or a held input dispatched later still spends the same budget.
 */

type Db = ReturnType<BbPluginApi["storage"]["database"]>;
export type ApprovedSpec = { provider: string; model?: string };
export type Approval = {
  gameId: string;
  root: string;
  threadId: string | null;
  boardId: string | null;
  nodeId: string | null;
  budget: number;
  used: number;
  spec: ApprovedSpec | null;
  approvedAt: number;
};
type Row = {
  game: string;
  root: string;
  thread: string | null;
  board: string | null;
  node: string | null;
  budget: number;
  used: number;
  spec: string | null;
  approved: number;
};
const table = "studio_canvas_approvals";

export class ApprovalStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      game TEXT NOT NULL, root TEXT NOT NULL, thread TEXT, board TEXT, node TEXT,
      budget INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, spec TEXT, approved INTEGER NOT NULL,
      PRIMARY KEY (game, root))`);
  }
  private static approval(row: Row): Approval {
    return {
      gameId: row.game,
      root: row.root,
      threadId: row.thread,
      boardId: row.board,
      nodeId: row.node,
      budget: row.budget,
      used: row.used,
      spec: row.spec ? (JSON.parse(row.spec) as ApprovedSpec) : null,
      approvedAt: row.approved,
    };
  }
  /** Records an approval for a request lineage, replacing an earlier one for the same root. */
  grant(approval: Omit<Approval, "used" | "approvedAt">) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${table} (game, root, thread, board, node, budget, used, spec, approved)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        approval.gameId,
        approval.root,
        approval.threadId,
        approval.boardId,
        approval.nodeId,
        approval.budget,
        approval.spec ? JSON.stringify(approval.spec) : null,
        Date.now(),
      );
  }
  get(gameId: string, root: string): Approval | undefined {
    const row = this.db
      .prepare(`SELECT * FROM ${table} WHERE game = ? AND root = ?`)
      .get(gameId, root) as Row | undefined;
    return row && ApprovalStore.approval(row);
  }
  /**
   * Spends `count` of the lineage's budget. True when it may go ahead: nobody approved this
   * lineage (a run from the canvas UI), or enough of its budget remains.
   */
  consume(gameId: string, root: string, count: number): boolean {
    const row = this.get(gameId, root);
    if (!row) return true;
    if (row.used + count > row.budget) return false;
    this.db
      .prepare(`UPDATE ${table} SET used = used + ? WHERE game = ? AND root = ?`)
      .run(count, gameId, root);
    return true;
  }
}
