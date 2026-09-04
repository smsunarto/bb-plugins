import {
  createThreadAttention,
  type AttentionChannel,
  type AttentionSource,
  type ThreadAttention,
} from "./thread-attention.ts";
import {
  parseDeliveryEnvelope,
  rendererHttpPaths,
  rendererHttpUrl,
  type DeliveryEnvelope,
  type RendererOutcome,
} from "../shared/renderer-http.ts";

const POLL_LOCK = "bb-plugin-notify:renderer";
const RETRY_DELAY_MS = 3_000;
const MIN_EMPTY_POLL_MS = 500;

type NotificationInstance = Readonly<{
  addEventListener(type: "click" | "close", listener: () => void): void;
  close(): void;
}>;

type NotificationConstructor = Readonly<{
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
}> &
  (new (title: string, options?: NotificationOptions) => NotificationInstance);

type LockManager = Readonly<{
  request(
    name: string,
    options: { signal: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<void>;
}>;

export type RendererDependencies = Readonly<{
  fetch: typeof globalThis.fetch;
  Notification: NotificationConstructor | undefined;
  locks: LockManager | undefined;
  desktopBridge: unknown;
  focus: () => void;
  attentionSource: AttentionSource;
  createAttentionChannel: () => AttentionChannel | null;
}>;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  let wake = () => {};
  const sleeper = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const timer = setTimeout(wake, ms);
  const onAbort = () => {
    clearTimeout(timer);
    wake();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return sleeper.finally(() => signal.removeEventListener("abort", onAbort));
}

async function nextEnvelope(
  fetch: typeof globalThis.fetch,
  pluginId: string,
  signal: AbortSignal,
): Promise<DeliveryEnvelope | null> {
  const response = await fetch(rendererHttpUrl(pluginId, rendererHttpPaths.next), {
    credentials: "same-origin",
    signal,
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const envelope = parseDeliveryEnvelope(await response.json());
  if (envelope === null) throw new Error("invalid notification envelope");
  return envelope;
}

async function acknowledge(
  fetch: typeof globalThis.fetch,
  pluginId: string,
  id: string,
  outcome: RendererOutcome,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(rendererHttpUrl(pluginId, rendererHttpPaths.acknowledge), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, outcome }),
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

async function openThread(
  fetch: typeof globalThis.fetch,
  pluginId: string,
  threadId: string,
): Promise<void> {
  const response = await fetch(rendererHttpUrl(pluginId, rendererHttpPaths.openThread), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId }),
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

async function present(
  envelope: DeliveryEnvelope,
  pluginId: string,
  dependencies: RendererDependencies,
  attention: ThreadAttention,
): Promise<"shown" | "suppressed"> {
  return attention.present(envelope.notification.threadId, () => {
    const NotificationApi = dependencies.Notification;
    if (NotificationApi === undefined) throw new Error("Notification API unavailable");
    const notification = new NotificationApi(envelope.notification.title, {
      body: envelope.notification.body,
      silent: envelope.notification.silent,
      tag: `bb-notify-${envelope.id}`,
    });
    notification.addEventListener("click", () => {
      dependencies.focus();
      if (envelope.notification.threadId !== null) {
        void openThread(dependencies.fetch, pluginId, envelope.notification.threadId).catch(
          () => {},
        );
      }
      notification.close();
    });
    return notification;
  });
}

async function poll(
  signal: AbortSignal,
  pluginId: string,
  dependencies: RendererDependencies,
  attention: ThreadAttention,
): Promise<void> {
  let next = nextEnvelope(dependencies.fetch, pluginId, signal);
  while (!signal.aborted) {
    let envelope: DeliveryEnvelope | null;
    try {
      envelope = await next;
    } catch {
      if (signal.aborted) return;
      await sleep(RETRY_DELAY_MS, signal);
      next = nextEnvelope(dependencies.fetch, pluginId, signal);
      continue;
    }
    if (envelope === null) {
      await sleep(MIN_EMPTY_POLL_MS, signal);
      next = nextEnvelope(dependencies.fetch, pluginId, signal);
      continue;
    }

    next = nextEnvelope(dependencies.fetch, pluginId, signal);
    let outcome: RendererOutcome;
    try {
      outcome = await present(envelope, pluginId, dependencies, attention);
    } catch {
      outcome = "failed";
    }
    try {
      await acknowledge(dependencies.fetch, pluginId, envelope.id, outcome, signal);
    } catch {
      if (signal.aborted) return;
    }
  }
}

function browserDependencies(): RendererDependencies {
  const desktopBridge = (window as Window & { readonly bbDesktop?: unknown }).bbDesktop;
  const windowEvents = {
    addEventListener(type: string, listener: () => void) {
      window.addEventListener(type, listener);
    },
    removeEventListener(type: string, listener: () => void) {
      window.removeEventListener(type, listener);
    },
  };
  const documentEvents = {
    addEventListener(type: string, listener: () => void) {
      document.addEventListener(type, listener);
    },
    removeEventListener(type: string, listener: () => void) {
      document.removeEventListener(type, listener);
    },
  };
  return {
    fetch: globalThis.fetch.bind(globalThis),
    Notification: globalThis.Notification as unknown as NotificationConstructor | undefined,
    locks: navigator.locks as unknown as LockManager | undefined,
    desktopBridge,
    focus: () => window.focus(),
    attentionSource: {
      pathname: () => window.location.pathname,
      visibilityState: () => document.visibilityState,
      hasFocus: () => document.hasFocus(),
      windowEvents,
      documentEvents,
    },
    createAttentionChannel: () => {
      if (globalThis.BroadcastChannel === undefined) return null;
      try {
        return new BroadcastChannel("bb-plugin-notify:thread-attention") as AttentionChannel;
      } catch {
        return null;
      }
    },
  };
}

export async function mountNotificationRenderer(options: {
  signal: AbortSignal;
  pluginId: string;
  dependencies?: RendererDependencies;
}): Promise<void> {
  const dependencies = options.dependencies ?? browserDependencies();
  if (dependencies.desktopBridge === undefined) return;
  const attention = createThreadAttention({
    signal: options.signal,
    source: dependencies.attentionSource,
    channel: dependencies.createAttentionChannel(),
  });
  const NotificationApi = dependencies.Notification;
  if (NotificationApi === undefined || dependencies.locks === undefined) return;
  if (NotificationApi.permission === "default") await NotificationApi.requestPermission();
  if (NotificationApi.permission !== "granted" || options.signal.aborted) return;
  try {
    await dependencies.locks.request(POLL_LOCK, { signal: options.signal }, () =>
      poll(options.signal, options.pluginId, dependencies, attention),
    );
  } catch {
    if (!options.signal.aborted) throw new Error("notification renderer stopped");
  }
}
