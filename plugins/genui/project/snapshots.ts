// What Changes and Commits first showed in a reply, kept in plugin storage so
// an old reply keeps meaning what it meant. Keyed by the thread, the reply's
// block (the runtime's `blockKey`) and the request, so a block that streamed
// through `Changes()` before settling on `Changes("uncommitted")` never shows
// one as the other.
import { createHash } from "node:crypto";
import type { ChangesView, CommitsView, FilePatch, ProjectRequest } from "../core/project";

/** BB's kv rows hold at most 256 KB; leave room for the envelope. */
export const SNAPSHOT_BYTES = 240_000;

/** One file's patch larger than this is not kept: it would crowd out every other file's. */
export const PATCH_BYTES = 96_000;

const VERSION = 1;

/** The part of plugin storage snapshots use (`bb.storage.kv`). */
export interface SnapshotStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

interface Envelope<K extends string, V> {
  readonly v: number;
  readonly kind: K;
  readonly threadId: string;
  readonly view: V;
}

export function snapshotKey(threadId: string, blockKey: string, request: ProjectRequest): string {
  const digest = createHash("sha256").update(JSON.stringify([blockKey, request])).digest("base64url").slice(0, 32);
  return `snapshot:${threadId}:${digest}`;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * `view` cut to what fits in one storage row: every file's row if they fit
 * (else the first ones, marked truncated), then whole patches in file order
 * while they fit. A file whose patch isn't kept says so when opened.
 */
export function fitChanges(view: ChangesView, patches: readonly FilePatch[], maxBytes = SNAPSHOT_BYTES): ChangesView {
  let used = bytes({ ...view, files: [], patches: [] });
  let files = view.files;
  let listTruncated = view.listTruncated;
  let fileBytes = 0;
  for (let index = 0; index < view.files.length; index++) {
    const size = bytes(view.files[index]) + 1;
    if (used + fileBytes + size > maxBytes) {
      files = view.files.slice(0, index);
      listTruncated = true;
      break;
    }
    fileBytes += size;
  }
  used += fileBytes;
  const byPath = new Map(patches.map((patch) => [patch.path, patch]));
  const kept: FilePatch[] = [];
  for (const file of files) {
    const patch = byPath.get(file.path);
    if (patch === undefined) continue;
    const size = bytes(patch) + 1;
    if (size > PATCH_BYTES || used + size > maxBytes) continue;
    kept.push(patch);
    used += size;
  }
  return { ...view, files, listTruncated, patches: kept, livePatches: false, stored: true };
}

/** Snapshots read and written for one thread; null when there is none (or it isn't readable). */
export interface Snapshots {
  readChanges(key: string, threadId: string): Promise<ChangesView | null>;
  writeChanges(key: string, threadId: string, view: ChangesView): Promise<void>;
  readCommits(key: string, threadId: string): Promise<CommitsView | null>;
  writeCommits(key: string, threadId: string, view: CommitsView): Promise<void>;
}

export function createSnapshots(storage: SnapshotStorage): Snapshots {
  async function read<K extends string, V>(key: string, kind: K, threadId: string): Promise<V | null> {
    const stored = await storage.get<Envelope<K, V>>(key).catch(() => undefined);
    // A row from another version, kind or thread is not this block's snapshot.
    if (stored === undefined || stored === null || stored.v !== VERSION || stored.kind !== kind || stored.threadId !== threadId) {
      return null;
    }
    return stored.view;
  }
  async function write<K extends string, V>(key: string, kind: K, threadId: string, view: V): Promise<void> {
    const envelope: Envelope<K, V> = { v: VERSION, kind, threadId, view };
    await storage.set(key, envelope);
  }
  return {
    readChanges: (key: string, threadId: string) => read<"changes", ChangesView>(key, "changes", threadId),
    writeChanges: (key: string, threadId: string, view: ChangesView) => write(key, "changes", threadId, view),
    readCommits: (key: string, threadId: string) => read<"commits", CommitsView>(key, "commits", threadId),
    writeCommits: (key: string, threadId: string, view: CommitsView) => write(key, "commits", threadId, view),
  };
}
