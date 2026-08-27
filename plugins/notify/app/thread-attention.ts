const ROUTE_POLL_MS = 400;
const PROBE_TIMEOUT_MS = 40;

export type ActiveThreadView = Readonly<{ threadId: string }> | null;

export type AttentionMessage =
  | Readonly<{ kind: "probe"; probeId: string; threadId: string }>
  | Readonly<{ kind: "probe-hit"; probeId: string }>
  | Readonly<{ kind: "viewed"; threadId: string }>;

export type NotificationInstance = Readonly<{
  addEventListener(type: "close", listener: () => void): void;
  close(): void;
}>;

export type LiveNotifications = Map<string, Set<NotificationInstance>>;

export type AttentionEvent = Readonly<{ data: unknown }>;

export type AttentionChannel = Readonly<{
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: AttentionEvent) => void): void;
  removeEventListener(type: "message", listener: (event: AttentionEvent) => void): void;
  close(): void;
}>;

export type AttentionEventTarget = Readonly<{
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}>;

export type AttentionSource = Readonly<{
  pathname(): string;
  visibilityState(): DocumentVisibilityState;
  hasFocus(): boolean;
  windowEvents: AttentionEventTarget;
  documentEvents: AttentionEventTarget;
}>;

export type ThreadAttention = Readonly<{
  present(
    threadId: string | null,
    createNotification: () => NotificationInstance,
  ): Promise<"shown" | "suppressed">;
}>;

type PendingPresentation = { viewed: boolean };

type PendingProbe = Readonly<{
  resolve: (viewed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThreadId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
}

function isProbeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

export function parseAttentionMessage(value: unknown): AttentionMessage | null {
  if (!isRecord(value)) return null;
  if (
    value.kind === "probe" &&
    isProbeId(value.probeId) &&
    isThreadId(value.threadId) &&
    hasOnlyKeys(value, ["kind", "probeId", "threadId"])
  ) {
    return { kind: "probe", probeId: value.probeId, threadId: value.threadId };
  }
  if (
    value.kind === "probe-hit" &&
    isProbeId(value.probeId) &&
    hasOnlyKeys(value, ["kind", "probeId"])
  ) {
    return { kind: "probe-hit", probeId: value.probeId };
  }
  if (
    value.kind === "viewed" &&
    isThreadId(value.threadId) &&
    hasOnlyKeys(value, ["kind", "threadId"])
  ) {
    return { kind: "viewed", threadId: value.threadId };
  }
  return null;
}

export function threadIdFromPathname(pathname: string): string | null {
  return /(?:^|\/)threads?\/([A-Za-z0-9_-]{1,64})(?:\/|$)/u.exec(pathname)?.[1] ?? null;
}

export function activeThreadView(source: AttentionSource): ActiveThreadView {
  if (source.visibilityState() !== "visible" || !source.hasFocus()) return null;
  const threadId = threadIdFromPathname(source.pathname());
  return threadId === null ? null : { threadId };
}

export function createThreadAttention(options: {
  signal: AbortSignal;
  source: AttentionSource;
  channel: AttentionChannel | null;
  createProbeId?: () => string;
  probeTimeoutMs?: number;
  routePollMs?: number;
}): ThreadAttention {
  const createProbeId = options.createProbeId ?? (() => crypto.randomUUID());
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const routePollMs = options.routePollMs ?? ROUTE_POLL_MS;
  const liveNotifications: LiveNotifications = new Map();
  const pendingPresentations = new Map<string, Set<PendingPresentation>>();
  const pendingProbes = new Map<string, PendingProbe>();
  let currentView: ActiveThreadView = null;
  let disposed = false;

  function closeThread(threadId: string): void {
    for (const pending of pendingPresentations.get(threadId) ?? []) pending.viewed = true;
    const live = liveNotifications.get(threadId);
    if (live === undefined) return;
    liveNotifications.delete(threadId);
    for (const notification of live) notification.close();
  }

  function publishViewed(threadId: string): void {
    closeThread(threadId);
    options.channel?.postMessage({ kind: "viewed", threadId } satisfies AttentionMessage);
  }

  function sample(announceCurrent = false): void {
    const next = activeThreadView(options.source);
    const changed = next?.threadId !== currentView?.threadId;
    currentView = next;
    if (next !== null && (changed || announceCurrent)) publishViewed(next.threadId);
  }

  function finishProbe(probeId: string, viewed: boolean): void {
    const pending = pendingProbes.get(probeId);
    if (pending === undefined) return;
    pendingProbes.delete(probeId);
    clearTimeout(pending.timer);
    pending.resolve(viewed);
  }

  function onMessage(event: AttentionEvent): void {
    const message = parseAttentionMessage(event.data);
    if (message === null) return;
    if (message.kind === "probe") {
      if (activeThreadView(options.source)?.threadId === message.threadId) {
        options.channel?.postMessage({
          kind: "probe-hit",
          probeId: message.probeId,
        } satisfies AttentionMessage);
      }
      return;
    }
    if (message.kind === "probe-hit") {
      finishProbe(message.probeId, true);
      return;
    }
    closeThread(message.threadId);
  }

  function probe(threadId: string): Promise<boolean> {
    if (activeThreadView(options.source)?.threadId === threadId) return Promise.resolve(true);
    if (options.channel === null || disposed) return Promise.resolve(false);
    const probeId = createProbeId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => finishProbe(probeId, false), probeTimeoutMs);
      pendingProbes.set(probeId, { resolve, timer });
      options.channel?.postMessage({ kind: "probe", probeId, threadId } satisfies AttentionMessage);
    });
  }

  function track(threadId: string, notification: NotificationInstance): void {
    const live = liveNotifications.get(threadId) ?? new Set();
    live.add(notification);
    liveNotifications.set(threadId, live);
    notification.addEventListener("close", () => {
      const current = liveNotifications.get(threadId);
      current?.delete(notification);
      if (current?.size === 0) liveNotifications.delete(threadId);
    });
  }

  function addPending(threadId: string, pending: PendingPresentation): void {
    const entries = pendingPresentations.get(threadId) ?? new Set();
    entries.add(pending);
    pendingPresentations.set(threadId, entries);
  }

  function removePending(threadId: string, pending: PendingPresentation): void {
    const entries = pendingPresentations.get(threadId);
    entries?.delete(pending);
    if (entries?.size === 0) pendingPresentations.delete(threadId);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearInterval(routeTimer);
    for (const [target, type, listener] of sampledEvents) {
      target.removeEventListener(type, listener);
    }
    options.channel?.removeEventListener("message", onMessage);
    options.channel?.close();
    for (const probeId of pendingProbes.keys()) finishProbe(probeId, false);
  }

  const sampleCurrent = () => sample(true);
  const sampleChanged = () => sample();
  const sampledEvents: ReadonlyArray<readonly [AttentionEventTarget, string, () => void]> = [
    [options.source.windowEvents, "focus", sampleCurrent],
    [options.source.windowEvents, "blur", sampleChanged],
    [options.source.windowEvents, "pageshow", sampleCurrent],
    [options.source.documentEvents, "visibilitychange", sampleCurrent],
  ];
  for (const [target, type, listener] of sampledEvents) {
    target.addEventListener(type, listener);
  }
  options.channel?.addEventListener("message", onMessage);
  const routeTimer = setInterval(sample, routePollMs);
  options.signal.addEventListener("abort", dispose, { once: true });
  sample(true);
  if (options.signal.aborted) dispose();

  return {
    async present(threadId, createNotification) {
      if (threadId === null) {
        createNotification();
        return "shown";
      }
      const pending = { viewed: false } satisfies PendingPresentation;
      addPending(threadId, pending);
      try {
        const viewed = await probe(threadId);
        if (viewed || pending.viewed || activeThreadView(options.source)?.threadId === threadId) {
          return "suppressed";
        }
        const notification = createNotification();
        track(threadId, notification);
        return "shown";
      } finally {
        removePending(threadId, pending);
      }
    },
  };
}
