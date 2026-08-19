// File-backed ACP sessionId -> Amp thread id store. Each session owns one
// atomic record so concurrently spawned bridge processes never rewrite shared
// state. All operations are best-effort: a broken store must never break a
// prompt.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionBinding, SessionStore } from "./bridge-core.ts";
import { parseStoredExecutionTarget, type AmpExecutionTarget } from "./execution-target.ts";

const MAX_ENTRIES = 200;

interface StoredSession {
  sessionId?: string;
  threadId: string;
  executionTarget: AmpExecutionTarget;
  updatedAt: number;
}

export function defaultSessionStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "bb-plugin-amp", "sessions.json");
}

export function createFileSessionStore(filePath = defaultSessionStorePath()): SessionStore {
  const recordsDirectory = join(dirname(filePath), "sessions");

  function recordPath(sessionId: string): string {
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return join(recordsDirectory, `${digest}.json`);
  }

  function parseSession(value: unknown, expectedSessionId?: string): StoredSession | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const entry = value as Partial<StoredSession>;
    if (typeof entry.threadId !== "string" || entry.threadId.length === 0) return null;
    if (expectedSessionId !== undefined && entry.sessionId !== expectedSessionId) return null;
    const executionTarget =
      entry.executionTarget === undefined
        ? "local"
        : parseStoredExecutionTarget(entry.executionTarget);
    // Missing means a legacy Local binding. An explicit unknown value is a
    // corrupt execution boundary and must fail closed instead of running Local.
    if (executionTarget === null) return null;
    return {
      sessionId: entry.sessionId,
      threadId: entry.threadId,
      executionTarget,
      updatedAt:
        typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
          ? entry.updatedAt
          : 0,
    };
  }

  function readRecord(sessionId: string): StoredSession | null {
    try {
      return parseSession(JSON.parse(readFileSync(recordPath(sessionId), "utf8")), sessionId);
    } catch {
      return null;
    }
  }

  function loadLegacy(): Record<string, StoredSession> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const sessions: Record<string, StoredSession> = {};
        for (const [sessionId, value] of Object.entries(parsed)) {
          const entry = parseSession(value);
          if (entry) sessions[sessionId] = entry;
        }
        return sessions;
      }
    } catch {
      // Missing or corrupt legacy store: use independent records only.
    }
    return {};
  }

  function writeRecord(sessionId: string, entry: StoredSession): void {
    mkdirSync(recordsDirectory, { recursive: true });
    const destination = recordPath(sessionId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const record: StoredSession = { ...entry, sessionId };
      writeFileSync(temporary, `${JSON.stringify(record, null, "\t")}\n`, "utf8");
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  function pruneRecords(currentPath?: string): void {
    const records = readdirSync(recordsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        const path = join(recordsDirectory, entry.name);
        let updatedAt = 0;
        try {
          const parsed = parseSession(JSON.parse(readFileSync(path, "utf8")));
          updatedAt = parsed?.updatedAt ?? 0;
        } catch {
          // Corrupt records are the first pruning candidates.
        }
        return { path, updatedAt };
      });
    const removeCount = records.length - MAX_ENTRIES;
    if (removeCount <= 0) return;
    const candidates = records
      .filter((record) => record.path !== currentPath)
      .sort((a, b) => a.updatedAt - b.updatedAt || a.path.localeCompare(b.path));
    for (const record of candidates.slice(0, removeCount)) {
      rmSync(record.path, { force: true });
    }
  }

  function migrateLegacyStore(): void {
    const legacy = loadLegacy();
    const entries = Object.entries(legacy);
    if (entries.length === 0) return;
    try {
      for (const [sessionId, entry] of entries) {
        if (!readRecord(sessionId)) writeRecord(sessionId, entry);
      }
      pruneRecords();
      try {
        renameSync(filePath, `${filePath}.migrated-${Date.now()}-${process.pid}`);
      } catch (error) {
        // Another bridge process may have completed the same migration after
        // this process read the legacy file.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } catch (error) {
      // Keep sessions.json in place as a read fallback if migration did not
      // finish. Another process or a later bridge start can retry safely.
      console.error("[amp] failed to migrate legacy session mappings", error);
    }
  }

  migrateLegacyStore();

  return {
    get(sessionId) {
      const record = readRecord(sessionId);
      if (record) {
        return {
          threadId: record.threadId,
          executionTarget: record.executionTarget,
        };
      }

      // Migration may have failed because the state directory was temporarily
      // unwritable. Preserve resume behavior while the legacy file remains.
      const legacy = loadLegacy()[sessionId];
      return legacy
        ? {
            threadId: legacy.threadId,
            executionTarget: legacy.executionTarget,
          }
        : null;
    },
    set(sessionId, binding: SessionBinding) {
      try {
        const destination = recordPath(sessionId);
        writeRecord(sessionId, {
          sessionId,
          threadId: binding.threadId,
          executionTarget: binding.executionTarget,
          updatedAt: Date.now(),
        });
        pruneRecords(destination);
      } catch (error) {
        console.error("[amp] failed to persist session mapping", error);
      }
    },
  };
}
