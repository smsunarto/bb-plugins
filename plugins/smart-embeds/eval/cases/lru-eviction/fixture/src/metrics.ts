export type RemovalReason = "capacity" | "size" | "expired";

export interface RemovalRecord {
  key: string;
  reason: RemovalReason;
  bytes: number;
  at: number;
}

export interface MetricsSnapshot {
  hits: number;
  misses: number;
  hitRate: number;
  evictions: number;
  expirations: number;
  overflows: number;
  rejections: number;
  rejectedBytes: number;
  bytesReclaimed: number;
  recent: RemovalRecord[];
}

const DEFAULT_HISTORY_LIMIT = 32;

export class CacheMetrics {
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;
  private overflows = 0;
  private rejections = 0;
  private rejectedBytes = 0;
  private bytesReclaimed = 0;
  private readonly history: RemovalRecord[] = [];
  private readonly historyLimit: number;

  constructor(historyLimit: number = DEFAULT_HISTORY_LIMIT) {
    this.historyLimit = historyLimit;
  }

  hit(): void {
    this.hits += 1;
  }

  miss(): void {
    this.misses += 1;
  }

  /** A write refused before it ever reached the cache. */
  reject(bytes: number): void {
    this.rejections += 1;
    this.rejectedBytes += bytes;
  }

  /** The cache is over a ceiling and nothing removable is left. */
  overflow(): void {
    this.overflows += 1;
  }

  /**
   * Splits removals by why they happened. A deadline that passed says nothing
   * about capacity, so only the pressure reasons count toward `evictions`, and
   * a rising `evictions` with a flat `expirations` is what says the cache is
   * undersized.
   */
  recordRemoval(key: string, reason: RemovalReason, bytes: number, at: number): void {
    if (reason === "expired") this.expirations += 1;
    else this.evictions += 1;

    this.bytesReclaimed += bytes;
    this.history.push({ key, reason, bytes, at });
    if (this.history.length > this.historyLimit) this.history.shift();
  }

  snapshot(): MetricsSnapshot {
    const lookups = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: lookups === 0 ? 0 : this.hits / lookups,
      evictions: this.evictions,
      expirations: this.expirations,
      overflows: this.overflows,
      rejections: this.rejections,
      rejectedBytes: this.rejectedBytes,
      bytesReclaimed: this.bytesReclaimed,
      recent: [...this.history],
    };
  }

  reset(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.expirations = 0;
    this.overflows = 0;
    this.rejections = 0;
    this.rejectedBytes = 0;
    this.bytesReclaimed = 0;
    this.history.length = 0;
  }
}
