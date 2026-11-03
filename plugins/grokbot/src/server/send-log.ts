import { z } from "zod";
import { LOG_LIMIT, logEntrySchema, type LogEntry } from "../shared/contract.ts";

/** The kv key in bb's database that holds the newest-first send log. */
export const LOG_KEY = "send-log";

/** The slice of `bb.storage.kv` the log needs. */
export interface KvStore {
  get<T>(key: string): Promise<T | undefined | null>;
  set(key: string, value: unknown): Promise<void>;
}

export interface SendLog {
  append(entry: LogEntry): Promise<void>;
  recent(limit?: number): Promise<LogEntry[]>;
}

const storedSchema = z.array(logEntrySchema);

/**
 * A bounded newest-first log in one kv row. Entries hold the action, target,
 * a text preview, the thread context, and the outcome; never the URL or key.
 * Appends run one at a time so concurrent sends cannot drop each other.
 */
export function createSendLog(kv: KvStore, limit = LOG_LIMIT): SendLog {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<LogEntry[]> => {
    const parsed = storedSchema.safeParse(await kv.get<unknown>(LOG_KEY));
    return parsed.success ? parsed.data : [];
  };
  return {
    append(entry) {
      const next = queue.then(async () => {
        const entries = await read();
        return kv.set(LOG_KEY, [entry, ...entries].slice(0, limit));
      });
      queue = next.catch(() => undefined);
      return next;
    },
    async recent(count = limit) {
      await queue;
      return (await read()).slice(0, count);
    },
  };
}
