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

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/**
 * Pierre strips Git's quotes from a header path but keeps its C-style escapes
 * (`\"`, `\t`, octal UTF-8 bytes). Git quotes every path containing a
 * backslash, so any backslash left in a parsed name is an escape.
 */
export function unquoteGitPath(name: string): string {
  if (!name.includes("\\")) return name;
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (let i = 0; i < name.length;) {
    if (name[i] !== "\\") {
      // Whole code points: an astral character is two UTF-16 units.
      const char = String.fromCodePoint(name.codePointAt(i)!);
      bytes.push(...encoder.encode(char));
      i += char.length;
      continue;
    }
    const octal = name.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 4;
    } else {
      const next = name[i + 1] ?? "";
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
      i += 2;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function splitPatch(patch: string, idPrefix: string): Change[] {
  const chunks = patch.split(GIT_DIFF_FILE_BREAK_REGEX).filter((chunk) => chunk.trim() !== "");
  const changes: Change[] = [];
  for (const [index, patch] of chunks.entries()) {
    const id = `${idPrefix}${index}`;
    try {
      const file = getSingularPatch(patch);
      const added = file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0);
      const removed = file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0);
      changes.push({ id, path: unquoteGitPath(file.name), patch, added, removed });
    } catch {
      // Preserve unparseable and binary patches as text, never silently hide changes.
      changes.push({ id, path: "Recorded changes", patch, added: 0, removed: 0 });
    }
  }
  return changes;
}

export function turnChanges(turn: LatestTurn): Change[] {
  const others = turn.otherPatch ? splitPatch(turn.otherPatch, "other-") : [];
  for (const change of others) change.other = true;
  if (turn.patch === null || turn.patch.trim() === "") {
    return [...turn.changes.map(positionChange), ...others];
  }
  // Beside a patch, the server keeps in `turn.changes` only the recorded edits
  // the patch cannot cover: other workspaces, submodules, ignored files.
  return [...splitPatch(turn.patch, ""), ...turn.changes.map(positionChange), ...others];
}
