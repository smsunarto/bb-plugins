// Slow-changing facts a dispatch should not wait for: a fresh answer is
// reused, a stale one is served at once while a refresh runs behind it, and
// only a missing one makes the caller wait.

const REFRESH_DELAY_MS = 50;

export class SwrCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly load: (key: string) => Promise<T>,
    private readonly freshMs: number,
    private readonly staleMs: number,
  ) {}

  async get(key: string): Promise<T> {
    const entry = this.entries.get(key);
    const age = entry === undefined ? Infinity : Date.now() - entry.at;
    if (entry !== undefined && age < this.freshMs) return entry.value;
    if (entry !== undefined && age < this.staleMs) {
      // The stale value is good enough, and a failed refresh just leaves it in
      // place. The refresh starts a moment later rather than now: starting one
      // can cost synchronous work, and the caller is about to do something
      // that matters more.
      const timer = setTimeout(() => void this.refresh(key).catch(() => {}), REFRESH_DELAY_MS);
      timer.unref?.();
      return entry.value;
    }
    return this.refresh(key);
  }

  /** Load `key` now, sharing the work with anyone already loading it. */
  refresh(key: string): Promise<T> {
    const running = this.inflight.get(key);
    if (running !== undefined) return running;
    const loading = this.load(key)
      .then((value) => {
        this.entries.set(key, { value, at: Date.now() });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, loading);
    return loading;
  }
}
