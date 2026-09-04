import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ChangeKind = "add" | "update" | "remove";

export interface Change {
  kind: ChangeKind;
  /** Path relative to the note root, always with forward slashes. */
  path: string;
  bytes: number;
  /** Contents to publish. Absent for removals. */
  body?: string;
}

export interface SyncPlan {
  source: string;
  target: string;
  changes: Change[];
}

const NOTE_EXTENSION = ".md";
const encoder = new TextEncoder();

function byteLength(body: string): number {
  return encoder.encode(body).length;
}

function collect(root: string, prefix: string, into: Map<string, string>): void {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    // Editor swap files, .git and friends are never part of a note tree.
    if (entry.name.startsWith(".")) continue;
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      collect(root, path, into);
    } else if (entry.name.endsWith(NOTE_EXTENSION)) {
      into.set(path, readFileSync(join(root, path), "utf8"));
    }
  }
}

/** Reads every note under `root`, keyed by its path relative to `root`. */
export function readNotes(root: string): Map<string, string> {
  const notes = new Map<string, string>();
  if (existsSync(root)) collect(root, "", notes);
  return notes;
}

/**
 * Compares the authored tree against the published one. Notes are matched by
 * path and compared by content, because the publish step rewrites timestamps
 * and mtime alone would mark every note as changed.
 */
export function buildPlan(source: string, target: string): SyncPlan {
  const authored = readNotes(source);
  const published = readNotes(target);
  const changes: Change[] = [];

  for (const [path, body] of authored) {
    const current = published.get(path);
    if (current === undefined) {
      changes.push({ kind: "add", path, bytes: byteLength(body), body });
    } else if (current !== body) {
      changes.push({ kind: "update", path, bytes: byteLength(body), body });
    }
  }

  for (const [path, body] of published) {
    if (!authored.has(path)) {
      changes.push({ kind: "remove", path, bytes: byteLength(body) });
    }
  }

  changes.sort((left, right) => left.path.localeCompare(right.path));
  return { source, target, changes };
}
