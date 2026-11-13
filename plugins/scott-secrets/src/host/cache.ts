/**
 * Sudo passwords, held only in this host worker's memory, one per thread.
 *
 * Nothing here touches disk, settings, kv, or the server: anything persisted
 * would be readable by a same-user agent without asking. Values are Buffers
 * so eviction can overwrite them; the string the RPC delivered is left to the
 * garbage collector. A worker restart drops every entry, and the next request
 * simply asks for the password again.
 *
 * Expiry is fixed from when the password was typed and never extended by use:
 * an agent that can answer its own approval forms must not be able to keep a
 * root window open by running commands. Keying by thread keeps one thread's
 * password from approving another thread's commands.
 */
export interface WorkerLease {
  dispose(): Promise<void>;
}

interface Entry {
  value: Buffer;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

export class PasswordCache {
  private readonly entries = new Map<string, Entry>();
  private lease: WorkerLease | null = null;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Store a validated password for one thread; `retain` keeps the worker alive while any is cached. */
  set(threadId: string, password: Buffer, ttlMs: number, retain: () => WorkerLease): void {
    this.clear(threadId);
    const timer = setTimeout(() => this.clear(threadId), ttlMs);
    timer.unref();
    this.entries.set(threadId, { value: password, expiresAt: this.now() + ttlMs, timer });
    this.lease ??= retain();
  }

  /** The thread's cached password, or null when none is cached or it has expired. */
  get(threadId: string): Buffer | null {
    const entry = this.entries.get(threadId);
    if (!entry) return null;
    if (this.now() >= entry.expiresAt) {
      this.clear(threadId);
      return null;
    }
    return entry.value;
  }

  status(threadId: string): { cached: boolean; expiresAt: number | null } {
    return this.get(threadId) === null
      ? { cached: false, expiresAt: null }
      : { cached: true, expiresAt: this.entries.get(threadId)?.expiresAt ?? null };
  }

  /** Overwrite and drop one thread's password. Returns whether one was cached. */
  clear(threadId: string): boolean {
    const entry = this.entries.get(threadId);
    if (!entry) return false;
    entry.value.fill(0);
    clearTimeout(entry.timer);
    this.entries.delete(threadId);
    this.releaseWhenEmpty();
    return true;
  }

  /** Overwrite and drop every password. Returns how many were cached. */
  clearAll(): number {
    const count = this.entries.size;
    // Deleting the current key while iterating a Map is safe.
    for (const threadId of this.entries.keys()) this.clear(threadId);
    this.releaseWhenEmpty();
    return count;
  }

  private releaseWhenEmpty(): void {
    if (this.entries.size > 0) return;
    const lease = this.lease;
    this.lease = null;
    void lease?.dispose();
  }
}
