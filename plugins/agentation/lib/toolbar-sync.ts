/** Pure synchronization helpers for the browser-mounted Agentation toolbar. */

export interface ToolbarTextFieldState {
  value: string;
  focused: boolean;
  width: number;
  height: number;
  settingsField: boolean;
}

/**
 * Whether remounting Agentation would discard text the human is still editing.
 *
 * Agentation always mounts its settings textarea, even while the panel is
 * hidden. A saved webhook URL is durable settings state, not an annotation
 * draft, so it only blocks a remount while that field has the caret.
 */
export function toolbarTextFieldIsBusy(field: ToolbarTextFieldState): boolean {
  if (field.width === 0 || field.height === 0) return false;
  if (field.settingsField) return field.focused;
  return field.focused || field.value.trim() !== "";
}

/**
 * A cursor represents the newest server snapshot that reached local storage.
 * Write acknowledgements do not qualify: they can include unrelated agent
 * decisions that the toolbar has not reconciled yet.
 */
export function createReconciledCursor(initial = 0): {
  value: () => number;
  hasNewer: (candidate: number) => boolean;
  observe: (candidate: number, reconciled: boolean) => void;
  reset: () => void;
} {
  let current = initial;
  return {
    value: () => current,
    hasNewer: (candidate) => candidate > current,
    observe: (candidate, reconciled) => {
      if (reconciled && candidate > current) current = candidate;
    },
    reset: () => {
      current = 0;
    },
  };
}

/**
 * Cache one value per key and share concurrent cache misses.
 * A failed request is removed so the next caller can retry.
 */
export function createKeyedRequestCache<Key, Value>(): {
  get: (key: Key) => Value | undefined;
  getOrCreate: (key: Key, create: () => Promise<Value>) => Promise<Value>;
  forget: (key: Key) => void;
} {
  const values = new Map<Key, Value>();
  const inFlight = new Map<Key, Promise<Value>>();

  return {
    get: (key) => values.get(key),
    getOrCreate: (key, create) => {
      if (values.has(key)) return Promise.resolve(values.get(key) as Value);
      const active = inFlight.get(key);
      if (active) return active;

      const request = Promise.resolve()
        .then(create)
        .then((value) => {
          values.set(key, value);
          return value;
        })
        .finally(() => {
          inFlight.delete(key);
          return undefined;
        });
      inFlight.set(key, request);
      return request;
    },
    forget: (key) => {
      values.delete(key);
    },
  };
}

/** A route name alone cannot distinguish A -> B -> A navigation. */
export function isCurrentRouteRequest(
  requestRoute: string,
  requestRevision: number,
  currentRoute: string,
  currentRevision: number,
): boolean {
  return requestRoute === currentRoute && requestRevision === currentRevision;
}

/** Run mutations in call order, even when an earlier one is still in flight. */
export function createSerialTaskQueue(): {
  run: (task: () => Promise<void>) => Promise<void>;
} {
  let tail = Promise.resolve();
  return {
    run: (task) => {
      const result = tail.then(task);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = canonicalize(source[key]);
  }
  return sorted;
}

/**
 * Compare the complete local payload, independent of object key order.
 *
 * Agentation omits lifecycle fields for local-only feedback. The store fills
 * those protocol defaults before returning the same annotation, so normalize
 * them here. Otherwise a successful local Add looks like a remote edit and
 * forces a remount that closes Agentation's active tool.
 */
export function stableAnnotationSignature(
  annotations: readonly { id: string; [key: string]: unknown }[],
): string {
  return JSON.stringify(
    [...annotations]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((annotation) =>
        canonicalize({
          ...annotation,
          status: annotation.status ?? "pending",
          kind: annotation.kind ?? "feedback",
          thread: annotation.thread ?? [],
        }),
      ),
  );
}

/** Apply Agentation's callback delta to its persisted local projection. */
export function upsertLocalAnnotation<T extends { id: string }>(
  current: readonly T[],
  annotation: T,
): T[] {
  const index = current.findIndex((item) => item.id === annotation.id);
  if (index === -1) return [...current, annotation];
  return current.map((item, itemIndex) => (itemIndex === index ? annotation : item));
}

/** Remove Agentation's callback delta from its persisted local projection. */
export function deleteLocalAnnotation<T extends { id: string }>(
  current: readonly T[],
  annotationId: string,
): T[] {
  return current.filter((item) => item.id !== annotationId);
}

/**
 * Record every disposition the server accepted.
 *
 * A deleted id is a short-lived tombstone, not an id to remove here. The next
 * complete snapshot prunes it after any stale Agentation storage row has been
 * suppressed.
 */
export function recordPushAcknowledgement(
  current: ReadonlySet<string>,
  upsertedIds: readonly string[],
  deletedIds: readonly string[],
): Set<string> {
  const next = new Set(current);
  for (const id of upsertedIds) next.add(id);
  for (const id of deletedIds) next.add(id);
  return next;
}

/** Every id in a complete server snapshot is known to be durable there. */
export function recordSnapshotAcknowledgement(knownToServer: ReadonlySet<string>): Set<string> {
  return new Set(knownToServer);
}

/**
 * A failed operation may return to the live queue only when Clear did not
 * supersede it and no newer edit/delete for the same annotation exists.
 */
export function shouldRequeueOperation(
  operationRevision: number,
  clearedThroughRevision: number,
  currentRevision: number | null,
): boolean {
  return (
    operationRevision > clearedThroughRevision &&
    (currentRevision === null || operationRevision >= currentRevision)
  );
}

/**
 * Serialize refreshes and coalesce signals received while one is running.
 * One follow-up refresh observes every change that arrived during the active
 * request without allowing an older response to overwrite a newer one.
 */
export function createCoalescingQueue(
  run: () => Promise<void>,
  onDrained: () => void,
): { request: () => Promise<void> } {
  let requested = false;
  let running: Promise<void> | null = null;

  const request = (): Promise<void> => {
    requested = true;
    if (running) return running;

    const drain = Promise.resolve().then(async () => {
      while (requested) {
        requested = false;
        await run();
      }
      return undefined;
    });

    running = drain.finally(() => {
      running = null;
      return onDrained();
    });
    return running;
  };

  return { request };
}
