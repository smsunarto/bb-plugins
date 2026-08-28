/**
 * `src/orb-intent.ts` — the one-shot Orb intent slot.
 *
 * The composer toggle arms Orb for the next thread through the server's RPC;
 * the provider bridge consumes the intent when `thread/start` creates a
 * fresh session record. The two run in different processes, so the slot is
 * a file in the plugin's bridge data directory, the one directory both
 * sides share. Consuming is destructive (one thread per press), and a stale
 * intent expires so a toggle armed and abandoned cannot surprise-run Orb
 * much later.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ORB_INTENT_FILE = "orb-intent.json";

/** An intent older than this no longer arms Orb. */
export const ORB_INTENT_TTL_MS = 10 * 60 * 1000;

/** The bridge receives this directory as its `context.dataDir`; the server
 * derives the same path from its own data directory. A plugin cannot ask bb
 * for its plugin id, so the id is spelled here once.
 *
 * The two sides agree because the SDK gives each half a different scope.
 * `bb.server.experimental_dataDir` is documented as the server directory
 * "holding `config.json`, `bb.db` and `plugins/<id>/`", so it is the root and
 * needs the suffix below. `ProviderBridgeContext.dataDir` is documented as
 * already "scoped to the owning plugin", so the bridge needs no suffix. No
 * unit test can pin this: the plugin owns neither value, and asserting the
 * join would only restate the line above it.
 *
 * The SDK also calls the server value "deliberately not a place to write".
 * This writes there anyway, because the bridge is a separate process and
 * `bb.storage` does not reach it. The bridge's own directory is the only
 * channel the two share, so the write stays inside the bridge's scope. */
export function bridgeDataDirFor(bbDataDir: string): string {
  return join(bbDataDir, "plugins", "amp", "bridge-data");
}

function intentPath(dir: string): string {
  return join(dir, ORB_INTENT_FILE);
}

export function armOrbIntent(dir: string, now: number = Date.now()): void {
  mkdirSync(dir, { recursive: true });
  const path = intentPath(dir);
  // Write-then-rename so the bridge never reads a half-written file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ armedAt: now })}\n`, "utf8");
  renameSync(tmp, path);
}

export function disarmOrbIntent(dir: string): void {
  rmSync(intentPath(dir), { force: true });
}

/** True when the file at `path` holds an intent still inside its TTL. */
function isFreshIntent(path: string, now: number): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  let armedAt: unknown;
  try {
    const parsed: unknown = JSON.parse(raw);
    armedAt =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { armedAt?: unknown }).armedAt
        : undefined;
  } catch {
    armedAt = undefined;
  }
  // A future armedAt (clock adjustment) still counts as fresh, but only a
  // finite one. JSON.parse turns an overflowing literal such as 1e999 into
  // Infinity, and `now - Infinity` is -Infinity, so an unfinite armedAt would
  // read fresh against every clock and arm Orb from a corrupt file.
  if (!Number.isFinite(armedAt as number)) return false;
  return typeof armedAt === "number" && now - armedAt < ORB_INTENT_TTL_MS;
}

/** True while a fresh intent is armed. A stale or unreadable file is
 * removed, never reported armed. */
export function readOrbIntent(dir: string, now: number = Date.now()): boolean {
  const fresh = isFreshIntent(intentPath(dir), now);
  if (!fresh) disarmOrbIntent(dir);
  return fresh;
}

let claimCounter = 0;

/** Claim-then-read: at most one thread starts on Orb per armed intent.
 *
 * The claim is a rename, not a read followed by a delete. Two readers of one
 * file both see it armed and both start on Orb, while only one rename of a
 * given path can win. The bridge is a single process today, where the
 * synchronous read and delete cannot interleave, so this guards the case the
 * process topology does not: a second bridge sharing the directory. */
export function consumeOrbIntent(dir: string, now: number = Date.now()): boolean {
  const claim = `${intentPath(dir)}.claim.${process.pid}.${(claimCounter += 1)}`;
  try {
    renameSync(intentPath(dir), claim);
  } catch {
    return false;
  }
  try {
    return isFreshIntent(claim, now);
  } finally {
    rmSync(claim, { force: true });
  }
}
