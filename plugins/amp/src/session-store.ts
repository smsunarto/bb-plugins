/**
 * Persisted session records for the native provider bridge.
 *
 * Keyed by `providerThreadId` (deterministically minted from the bb thread
 * id, see `bridge/session.ts`), one JSON file per record under the bridge's
 * plugin data directory. The ACP bridge kept its records under
 * `$XDG_STATE_HOME/bb-plugin-amp/sessions`, keyed by the ACP session id; a
 * read that misses the new store falls back there so a pre-migration thread
 * resumes with its Amp thread binding intact (the runtime hands the old ACP
 * session id back as `providerThreadId`).
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseStoredExecutionTarget } from "./execution-target.ts";
import type { AmpSessionRecord, SessionStore } from "./bridge/session.ts";

/** Bound the record directory; evict the oldest `updatedAt` beyond this. */
const MAX_ENTRIES = 200;

function recordPath(dir: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return join(dir, `${digest}.json`);
}

/** Where the ACP bridge kept its records. */
export function legacySessionDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "bb-plugin-amp", "sessions");
}

interface StoredRecord extends AmpSessionRecord {
  providerThreadId: string;
  updatedAt: number;
}

function parseRecord(raw: unknown): AmpSessionRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const target = parseStoredExecutionTarget(record.executionTarget);
  if (target === null) return null;
  if (typeof record.threadId !== "string") return null;
  const ampThreadId = record.ampThreadId;
  if (ampThreadId !== null && typeof ampThreadId !== "string") return null;
  return { ampThreadId: ampThreadId ?? null, executionTarget: target, threadId: record.threadId };
}

/**
 * An ACP-era record: `threadId` there is AMP's thread id (`T-…`), and the bb
 * thread id was never stored. An absent execution target reads as "local"
 * (the field predates Orb); an invalid one fails closed, as the old store
 * did.
 */
function parseLegacyRecord(raw: unknown): AmpSessionRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.threadId !== "string" || record.threadId.length === 0) return null;
  const target =
    record.executionTarget === undefined
      ? "local"
      : parseStoredExecutionTarget(record.executionTarget);
  if (target === null) return null;
  return { ampThreadId: record.threadId, executionTarget: target, threadId: "" };
}

function readJson(path: string): unknown | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function prune(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  if (names.length <= MAX_ENTRIES) return;
  const dated = names.map((name) => {
    const path = join(dir, name);
    const raw = readJson(path) as { updatedAt?: unknown } | null;
    const updatedAt = typeof raw?.updatedAt === "number" ? raw.updatedAt : 0;
    return { path, updatedAt };
  });
  dated.sort((a, b) => a.updatedAt - b.updatedAt);
  for (const entry of dated.slice(0, dated.length - MAX_ENTRIES)) {
    rmSync(entry.path, { force: true });
  }
}

export function createSessionStore(options: {
  /** Record directory, normally `<pluginDataDir>/sessions`. */
  dir: string;
  /** ACP-era fallback directory; null disables the fallback (tests). */
  legacyDir?: string | null;
}): SessionStore {
  const dir = options.dir;
  const legacyDir = options.legacyDir === undefined ? legacySessionDir() : options.legacyDir;

  return {
    // Sync node:fs behind an async interface: records are one small JSON
    // file and the callers already treat the store as async (the sketch's
    // contract), which keeps room for a locking implementation later.
    async read(providerThreadId) {
      const own = parseRecord(readJson(recordPath(dir, providerThreadId)));
      if (own !== null) return own;
      if (legacyDir === null) return null;
      return parseLegacyRecord(readJson(recordPath(legacyDir, providerThreadId)));
    },
    async write(providerThreadId, record) {
      mkdirSync(dir, { recursive: true });
      const stored: StoredRecord = { providerThreadId, ...record, updatedAt: Date.now() };
      const path = recordPath(dir, providerThreadId);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(stored)}\n`, "utf8");
      renameSync(tmp, path);
      prune(dir);
    },
    async delete(providerThreadId) {
      rmSync(recordPath(dir, providerThreadId), { force: true });
      if (legacyDir !== null) {
        // A discarded thread must not resurrect from its ACP-era record.
        rmSync(recordPath(legacyDir, providerThreadId), { force: true });
      }
    },
  };
}

/** Kept for callers that need to check the store location exists. */
export function storeHasRecords(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
}
