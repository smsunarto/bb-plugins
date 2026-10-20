import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CanvasEntry, CanvasRead } from "../../shared/canvas-contract.ts";
import type { GenerationJob } from "../../shared/generation.ts";
import { studioHostContract } from "../../shared/host-contract.ts";
import type { Game } from "../../shared/schema.ts";

/**
 * One game's canvas as its host last read it. Never changed in place, so a
 * read in flight keeps the base it asked from.
 */
export type CanvasSnapshot = {
  readonly fingerprint: string;
  readonly entries: ReadonlyMap<string, CanvasEntry>;
  /** Only part of the canvas came; a read from this fingerprint sends the rest. */
  readonly more?: true;
};

/** How many games' canvases the server keeps as bases for the next read. */
const KEEP = 32;
/** A canvas still incomplete after this many parts is too large, or changing too fast, to show. */
const MAX_PARTS = 64;
const kept = new WeakMap<BbPluginApi, Map<string, CanvasSnapshot>>();

function apply(base: CanvasSnapshot | undefined, read: CanvasRead): CanvasSnapshot | null {
  if (read.status === "unchanged") return base?.fingerprint === read.fingerprint ? base : null;
  const more = read.more ? { more: read.more } : {};
  if (read.base === null)
    return {
      fingerprint: read.fingerprint,
      entries: new Map(Object.entries(read.entries)),
      ...more,
    };
  if (base?.fingerprint !== read.base) return null;
  const entries = new Map(base.entries);
  for (const key of read.removed) entries.delete(key);
  for (const [key, entry] of Object.entries(read.entries)) entries.set(key, entry);
  return { fingerprint: read.fingerprint, entries, ...more };
}

/**
 * Reads the game's canvas in one host call. The host answers from the last
 * read the server kept: "unchanged", or only the entries that changed. A
 * change larger than one host result comes in parts, one call each. With
 * `watch`, the read also keeps the canvas watched for an open studio.
 */
export async function readCanvas(
  bb: BbPluginApi,
  game: Pick<Game, "id" | "hostId" | "rootPath" | "kind">,
  { watch = false }: { watch?: boolean } = {},
): Promise<CanvasSnapshot> {
  let games = kept.get(bb);
  if (!games) {
    games = new Map();
    kept.set(bb, games);
  }
  const key = JSON.stringify([game.hostId, game.rootPath, game.kind]);
  const client = bb.hosts.experimental_client({ contract: studioHostContract });
  const read = (since?: string) =>
    client.call(
      "readCanvas",
      {
        rootPath: game.rootPath,
        kind: game.kind,
        ...(since ? { since } : {}),
        ...(watch ? { watch: { gameId: game.id } } : {}),
      },
      { hostId: game.hostId },
    );
  const base = games.get(key);
  // A host that restarted, or answered another base, sends the whole canvas.
  let next = apply(base, await read(base?.fingerprint)) ?? apply(undefined, await read());
  for (let part = 1; next?.more; part++) {
    if (part >= MAX_PARTS)
      throw new Error("The game's canvas is too large to read. Reload the workspace.");
    next = apply(next, await read(next.fingerprint));
  }
  if (!next) throw new Error("The host could not read the game's canvas. Reload the workspace.");
  games.delete(key);
  games.set(key, next);
  for (const old of games.keys()) {
    if (games.size <= KEEP) break;
    games.delete(old);
  }
  return next;
}

/** The generation jobs the host listed, newest first, and where it found them. */
export function snapshotJobs(snapshot: CanvasSnapshot): {
  jobs: GenerationJob[];
  workspacePath: string | null;
  stale: boolean;
} {
  const jobs: GenerationJob[] = [];
  let workspacePath: string | null = null;
  let stale = false;
  for (const [key, entry] of snapshot.entries) {
    if (entry.kind === "job" && key.startsWith("job:")) jobs.push(structuredClone(entry.job));
    if (entry.kind === "jobs") ({ workspacePath, stale } = entry);
  }
  jobs.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  return { jobs: jobs.slice(0, 100), workspacePath, stale };
}
