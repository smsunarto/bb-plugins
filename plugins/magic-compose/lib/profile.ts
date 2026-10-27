// Where a routing decision's time goes: named spans on one clock, so work that
// ran in parallel shows up as overlapping bars.

export interface Span {
  name: string;
  startMs: number;
  endMs: number;
}

export class Profiler {
  private readonly origin = performance.now();
  readonly spans: Span[] = [];

  /** Time `work` under `name`, whether it resolves or throws. */
  async time<T>(name: string, work: () => Promise<T>): Promise<T> {
    const startMs = this.elapsed();
    try {
      return await work();
    } finally {
      this.spans.push({ name, startMs, endMs: this.elapsed() });
    }
  }

  elapsed(): number {
    return Math.round(performance.now() - this.origin);
  }
}

/** A text timeline: one row per span, bars placed on a shared axis. */
export function formatSpans(spans: readonly Span[], width = 50): string {
  if (spans.length === 0) return "";
  const total = Math.max(...spans.map((span) => span.endMs), 1);
  const nameWidth = Math.max(...spans.map((span) => span.name.length));
  return [...spans]
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map((span) => {
      const from = Math.min(Math.floor((span.startMs / total) * width), width - 1);
      const to = Math.max(Math.ceil((span.endMs / total) * width), from + 1);
      const bar = " ".repeat(from) + "█".repeat(to - from) + " ".repeat(width - to);
      const took = `${span.endMs - span.startMs}ms`.padStart(7);
      return `${span.name.padEnd(nameWidth)} |${bar}| ${took}  @${span.startMs}`;
    })
    .join("\n");
}
