import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  boardSchema,
  type Asset,
  type Board,
  type BoardEdit,
  type CanvasNode,
  type EditSummary,
  type Workspace,
} from "../../shared/schema.ts";
import { nodeRefs } from "../../shared/inputs.ts";
import { nodeTakes } from "../../shared/takes.ts";

/*
 * What the server changed on a board for an agent, kept so a person can see it and put it
 * back. An edit is undoable while it is still the board's latest content and the outputs it
 * restores still exist; a studio save or a later edit moves the board on, and the record stays
 * as history. The newest twenty per board are kept, in the server's own database.
 */

type Db = ReturnType<BbPluginApi["storage"]["database"]>;
const table = "studio_canvas_edits";
const KEEP = 20;

/** An edit as the log lists it; `before`, the board an undo puts back, is read on its own. */
export type StoredEdit = Omit<BoardEdit, "undoable" | "blocker"> & {
  gameId: string;
  boardId: string;
  /** The content hashes of the board before and after, as its revision names them. */
  beforeContent: string | null;
  afterContent: string | null;
  /** The assets the board used before: its picks, library inputs, and takes. */
  uses: string[];
};
type Row = {
  id: string;
  game: string;
  board: string;
  thread: string | null;
  at: number;
  undo_of: string | null;
  before_content: string | null;
  after_content: string | null;
  uses: string;
  summary: string;
};
const listed = "id, game, board, thread, at, undo_of, before_content, after_content, uses, summary";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const named = ({ id, title: name, type }: CanvasNode) => ({ id, title: name || type, type });

/** The content hash a board revision names, or null for one not in the revision format. */
export function revisionContent(revision: string): string | null {
  try {
    const parsed: unknown = JSON.parse(revision);
    return typeof parsed === "object" &&
      parsed !== null &&
      "content" in parsed &&
      typeof parsed.content === "string"
      ? parsed.content
      : null;
  } catch {
    return null;
  }
}

/** What changed between two boards, node by node and wire by wire. */
export function summarizeEdit(before: Board, after: Board): EditSummary {
  const was = new Map(before.nodes.map((node) => [node.id, node]));
  const is = new Map(after.nodes.map((node) => [node.id, node]));
  const summary: EditSummary = {
    added: after.nodes.filter((node) => !was.has(node.id)).map(named),
    removed: before.nodes.filter((node) => !is.has(node.id)).map(named),
    updated: [],
    connected: [],
    disconnected: [],
  };
  for (const node of after.nodes) {
    const previous = was.get(node.id);
    if (!previous) continue;
    const fields: string[] = [];
    if ((node.title ?? "") !== (previous.title ?? "")) fields.push("title");
    if ((node.description ?? "") !== (previous.description ?? "")) fields.push("description");
    for (const key of new Set([...Object.keys(previous.data), ...Object.keys(node.data)]))
      if (!same(previous.data[key], node.data[key])) fields.push(key);
    if (fields.length) summary.updated.push({ ...named(node), fields });
  }
  const wire = ({ id, source, target }: Board["edges"][number]) => ({ id, source, target });
  const hadWire = new Set(before.edges.map(({ id }) => id));
  const hasWire = new Set(after.edges.map(({ id }) => id));
  summary.connected = after.edges.filter(({ id }) => !hadWire.has(id)).map(wire);
  summary.disconnected = before.edges.filter(({ id }) => !hasWire.has(id)).map(wire);
  return summary;
}

/** The assets a board's nodes use: their picks, library inputs, and takes. */
export function boardUses(board: Pick<Board, "nodes">): string[] {
  const uses = new Set<string>();
  for (const node of board.nodes) {
    for (const take of nodeTakes(node)) uses.add(take.assetId);
    for (const ref of nodeRefs(node))
      if (ref.type === "library" && typeof ref.assetId === "string") uses.add(ref.assetId);
  }
  return [...uses];
}

/** Why an edit cannot be undone on the board as it is now, or null when it can. */
export function undoBlocker(
  edit: Pick<StoredEdit, "afterContent" | "uses">,
  current: { revision: string },
  assets: Asset[],
): string | null {
  if (!edit.afterContent || revisionContent(current.revision) !== edit.afterContent)
    return "The board has changed since this edit.";
  const catalogued = new Set(assets.map(({ id }) => id));
  const gone = edit.uses.filter((id) => !catalogued.has(id));
  if (gone.length === 1)
    return `Undoing it would bring back an asset that no longer exists (${gone[0]}).`;
  if (gone.length)
    return `Undoing it would bring back ${gone.length} assets that no longer exist (${gone.join(", ")}).`;
  return null;
}

/** The board an undo saves: the earlier content, laid out as the board is now. */
export function restoredBoard(current: Board, before: Board): Board {
  const placed = new Map(current.nodes.map((node) => [node.id, node]));
  const nodes = before.nodes.map((node) => {
    const now = placed.get(node.id);
    return now
      ? {
          ...node,
          position: now.position,
          ...(now.width === undefined ? {} : { width: now.width }),
          ...(now.height === undefined ? {} : { height: now.height }),
        }
      : node;
  });
  return boardSchema.parse({ ...before, nodes, editorLayout: current.editorLayout });
}

export class CanvasEditStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY, game TEXT NOT NULL, board TEXT NOT NULL, thread TEXT, at INTEGER NOT NULL,
      undo_of TEXT, before_content TEXT, after_content TEXT, uses TEXT NOT NULL DEFAULT '[]',
      before TEXT NOT NULL, summary TEXT NOT NULL)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_board ON ${table} (game, board, at)`);
  }
  /** A listed row, or null for one whose record no longer reads. */
  private static edit(row: Row): StoredEdit | null {
    try {
      return {
        id: row.id,
        gameId: row.game,
        boardId: row.board,
        threadId: row.thread,
        at: row.at,
        ...(row.undo_of ? { undoOf: row.undo_of } : {}),
        beforeContent: row.before_content,
        afterContent: row.after_content,
        uses: JSON.parse(row.uses) as string[],
        summary: JSON.parse(row.summary) as EditSummary,
      };
    } catch {
      return null;
    }
  }
  /** Remembers a saved edit, and forgets the board's oldest beyond the newest twenty. */
  record(edit: {
    gameId: string;
    boardId: string;
    threadId: string | null;
    undoOf?: string;
    before: Board;
    after: Board;
    beforeRevision: string;
    afterRevision: string;
  }): { id: string; at: number; summary: EditSummary } {
    const id = randomUUID();
    const at = Date.now();
    const summary = summarizeEdit(edit.before, edit.after);
    this.db
      .prepare(
        `INSERT INTO ${table} (id, game, board, thread, at, undo_of, before_content, after_content, uses, before, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        edit.gameId,
        edit.boardId,
        edit.threadId,
        at,
        edit.undoOf ?? null,
        revisionContent(edit.beforeRevision),
        revisionContent(edit.afterRevision),
        JSON.stringify(boardUses(edit.before)),
        JSON.stringify(edit.before),
        JSON.stringify(summary),
      );
    this.db
      .prepare(
        `DELETE FROM ${table} WHERE game = ? AND board = ? AND id NOT IN
           (SELECT id FROM ${table} WHERE game = ? AND board = ? ORDER BY rowid DESC LIMIT ?)`,
      )
      .run(edit.gameId, edit.boardId, edit.gameId, edit.boardId, KEEP);
    return { id, at, summary };
  }
  /** One edit with the board an undo puts back. */
  get(gameId: string, editId: string): (StoredEdit & { before: Board }) | undefined {
    const row = this.db
      .prepare(`SELECT ${listed}, before FROM ${table} WHERE game = ? AND id = ?`)
      .get(gameId, editId) as (Row & { before: string }) | undefined;
    const edit = row && CanvasEditStore.edit(row);
    if (!row || !edit) return undefined;
    return { ...edit, before: boardSchema.parse(JSON.parse(row.before)) };
  }
  /** A game's edits, newest first, without the boards they put back. */
  list(gameId: string): StoredEdit[] {
    return (
      this.db
        .prepare(`SELECT ${listed} FROM ${table} WHERE game = ? ORDER BY rowid DESC`)
        .all(gameId) as Row[]
    ).flatMap((row) => {
      const edit = CanvasEditStore.edit(row);
      return edit ? [edit] : [];
    });
  }
  /** Each board's edits as a workspace read shows them, with whether each can be undone now. */
  forWorkspace(
    workspace: Pick<Workspace, "game" | "boards" | "assets">,
  ): Record<string, BoardEdit[]> {
    const result: Record<string, BoardEdit[]> = {};
    for (const edit of this.list(workspace.game.id)) {
      const current = workspace.boards.find(({ board }) => board.id === edit.boardId);
      if (!current) continue;
      const {
        gameId: _game,
        boardId: _board,
        uses,
        beforeContent: _b,
        afterContent,
        ...shown
      } = edit;
      const blocker = undoBlocker({ afterContent, uses }, current, workspace.assets);
      (result[edit.boardId] ??= []).push({
        ...shown,
        undoable: blocker === null,
        ...(blocker ? { blocker } : {}),
      });
    }
    return result;
  }
}
