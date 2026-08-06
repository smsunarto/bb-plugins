// File-backed ACP sessionId -> Amp thread id store. Enables session/load
// (bb thread resume) across bridge restarts. All operations are best-effort:
// a broken store must never break a prompt.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionStore } from "./bridge-core.ts";

const MAX_ENTRIES = 200;

interface StoredSession {
  threadId: string;
  updatedAt: number;
}

export function defaultSessionStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "bb-plugin-amp", "sessions.json");
}

export function createFileSessionStore(filePath = defaultSessionStorePath()): SessionStore {
  function load(): Record<string, StoredSession> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, StoredSession>;
      }
    } catch {
      // missing or corrupt store: start fresh
    }
    return {};
  }

  return {
    get(sessionId) {
      const entry = load()[sessionId];
      return typeof entry?.threadId === "string" ? entry.threadId : null;
    },
    set(sessionId, threadId) {
      try {
        const sessions = load();
        sessions[sessionId] = { threadId, updatedAt: Date.now() };
        const pruned = Object.fromEntries(
          Object.entries(sessions)
            .sort(([, a], [, b]) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0))
            .slice(0, MAX_ENTRIES),
        );
        mkdirSync(dirname(filePath), { recursive: true });
        const temporary = `${filePath}.${process.pid}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(pruned, null, "\t")}\n`, "utf8");
        renameSync(temporary, filePath);
      } catch (error) {
        console.error("[amp] failed to persist session mapping", error);
      }
    },
  };
}
