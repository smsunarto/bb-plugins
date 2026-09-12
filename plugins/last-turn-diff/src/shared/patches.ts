import { GIT_DIFF_FILE_BREAK_REGEX, getSingularPatch } from "@pierre/diffs";
import type { Change, LatestTurn } from "./contract.ts";

const HUNK_HEADER = /^@@ /m;

/**
 * Some providers (Devin's ACP file changes, BB's own new-file rows) record a
 * file change as `---`/`+++` headers followed by bare `-`/`+` lines with no
 * `@@` hunk header. BB's diff viewer cannot place those lines and falls back
 * to raw text. Synthesize a header so the diff renders, and flag the result so
 * the viewer hides line numbers it cannot know.
 */
export function positionPatch(patch: string): { patch: string; synthesized: boolean } {
  if (HUNK_HEADER.test(patch)) return { patch, synthesized: false };
  const lines = patch.split("\n");
  const header = lines.findIndex((line) => line.startsWith("+++ "));
  if (header === -1) return { patch, synthesized: false };
  const body = lines.slice(header + 1);
  const removed = body.filter((line) => line.startsWith("-")).length;
  const added = body.filter((line) => line.startsWith("+")).length;
  if (added + removed === 0) return { patch, synthesized: false };
  const hunk = `@@ -${removed ? 1 : 0},${removed} +${added ? 1 : 0},${added} @@`;
  lines.splice(header + 1, 0, hunk);
  return { patch: lines.join("\n"), synthesized: true };
}

function positionChange(change: Change): Change {
  if (change.patch === null) return change;
  const { patch, synthesized } = positionPatch(change.patch);
  return synthesized ? { ...change, patch, unpositioned: true } : change;
}

export function turnChanges(turn: LatestTurn): Change[] {
  if (turn.patch === null) return turn.changes.map(positionChange);
  if (turn.patch.trim() === "") return turn.changes.map(positionChange);
  const chunks = turn.patch.split(GIT_DIFF_FILE_BREAK_REGEX).filter((chunk) => chunk.trim() !== "");
  const changes: Change[] = [];
  for (const [index, patch] of chunks.entries()) {
    try {
      const file = getSingularPatch(patch);
      const added = file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0);
      const removed = file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0);
      changes.push({ id: String(index), path: file.name, patch, added, removed });
    } catch {
      // Preserve unparseable and binary patches as text, never silently hide changes.
      changes.push({ id: String(index), path: "Recorded changes", patch, added: 0, removed: 0 });
    }
  }
  // The aggregate patch only covers the thread's own worktree; the server keeps
  // foreign-workspace row changes in `turn.changes` to render alongside it.
  return [
    ...changes,
    ...turn.changes.filter((change) => change.workspace !== undefined).map(positionChange),
  ];
}
