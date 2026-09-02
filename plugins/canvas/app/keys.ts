export interface Keyed<T> {
  readonly key: string;
  readonly item: T;
}

// React keys from content, with a suffix only when the content repeats, so
// identical rows or labels never collide and reorders keep their identity.
export function keyed<T>(items: readonly T[], keyOf: (item: T) => string): readonly Keyed<T>[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = keyOf(item);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { key: count === 0 ? base : `${base}#${count}`, item };
  });
}
