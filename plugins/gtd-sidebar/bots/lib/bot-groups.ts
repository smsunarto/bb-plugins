import type { InboxThreadNode, VisibleInboxRow } from "../../lib/inbox-tree.ts";
import { needsUser, type ProjectGroup } from "../../lib/project-groups.ts";

/**
 * One bot on the Bots shelf. It reuses the project group's shape, keyed by
 * bot id instead of project id, so the list window, folds and row rendering
 * treat a bot exactly like a project group.
 */
export interface BotGroup extends ProjectGroup {
  /** Completed conversations folded away (each with its subtree), still counted. */
  completed: number;
}

export interface BotGrouping {
  /** The bots the shelf shows, in their saved order. */
  botIds: readonly string[];
  ownerOf: (threadId: string) => string | null;
  isCompleted: (threadId: string) => boolean;
  /** Bots whose completed conversations the user asked to see. */
  showCompleted: ReadonlySet<string>;
  /** The open thread; its family stays visible even when completed. */
  activeThreadId: string | null;
}

/**
 * Splits the Bots shelf's rows into one group per shown bot, keeping the
 * shelf's own order inside each. A bot with no conversations still gets its
 * (empty) group, so it keeps its header and new-conversation button.
 *
 * A completed conversation folds away only with every descendant completed
 * too, so a child that reopened, works, or asks for input keeps its family on
 * screen. The open thread never folds, nor do a bot's conversations once the
 * user asks to see its completed ones.
 */
export function groupRowsByBot(
  rows: readonly VisibleInboxRow[],
  grouping: BotGrouping,
): BotGroup[] {
  const groups = new Map<string, BotGroup>(
    grouping.botIds.map((botId) => [
      botId,
      { projectId: botId, rows: [], families: 0, attention: 0, completed: 0 },
    ]),
  );
  const folded = foldedCompleted(grouping);
  let current: BotGroup | null = null;
  // The depth of the folded subtree the rows are inside: its rows fold with it.
  let foldedDepth: number | null = null;
  for (const row of rows) {
    if (row.depth === 0) {
      const botId = grouping.ownerOf(row.node.thread.id);
      current = botId === null ? null : (groups.get(botId) ?? null);
    }
    if (foldedDepth !== null && row.depth > foldedDepth) continue;
    foldedDepth = null;
    if (current === null) continue;
    if (!grouping.showCompleted.has(current.projectId) && folded(row.node)) {
      current.completed += 1;
      foldedDepth = row.depth;
      continue;
    }
    if (row.depth === 0) {
      current.families += 1;
      if (needsUser(row.node.statusThread)) current.attention += 1;
    }
    current.rows.push(row);
  }
  return [...groups.values()];
}

/** Whether a node and its whole subtree are completed and none of it is open. */
function foldedCompleted(grouping: BotGrouping): (node: InboxThreadNode) => boolean {
  const memo = new Map<string, boolean>();
  const folded = (node: InboxThreadNode): boolean => {
    const cached = memo.get(node.thread.id);
    if (cached !== undefined) return cached;
    const result =
      node.thread.id !== grouping.activeThreadId &&
      grouping.isCompleted(node.thread.id) &&
      node.children.every(folded);
    memo.set(node.thread.id, result);
    return result;
  };
  return folded;
}
