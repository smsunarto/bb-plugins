import { GIT_DIFF_FILE_BREAK_REGEX, getSingularPatch } from "@pierre/diffs";
import type { Change, LatestTurn } from "../shared/contract.ts";

export function turnChanges(turn: LatestTurn): Change[] {
  if (turn.patch === null) return turn.changes;
  if (turn.patch.trim() === "") return [];
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
  return changes;
}
