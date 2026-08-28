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
 * for its plugin id, so the id is spelled here once. */
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

/** True while a fresh intent is armed. A stale or unreadable file is
 * removed, never reported armed. */
export function readOrbIntent(dir: string, now: number = Date.now()): boolean {
  let raw: string;
  try {
    raw = readFileSync(intentPath(dir), "utf8");
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
  // A future armedAt (clock adjustment) still counts as fresh.
  const fresh = typeof armedAt === "number" && now - armedAt < ORB_INTENT_TTL_MS;
  if (!fresh) disarmOrbIntent(dir);
  return fresh;
}

/** Read-and-delete: at most one thread starts on Orb per armed intent. */
export function consumeOrbIntent(dir: string, now: number = Date.now()): boolean {
  const armed = readOrbIntent(dir, now);
  if (armed) disarmOrbIntent(dir);
  return armed;
}
