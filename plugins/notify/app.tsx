// Frontend half of bb-plugin-notify.
//
// macOS credits a notification to the process that posted it. A scripted
// notification is therefore always the interpreter's, which is why the
// osascript path wears the Script Editor icon. Posting from this window makes
// the notification BB's own: BB's icon, BB's name, and a click that opens the
// thread.
//
// A content script is used rather than a slot component because it is the only
// frontend surface that stays mounted everywhere in the app. It has no React
// context, so it cannot use the realtime hook — it long-polls the plugin's own
// HTTP route instead, one held request at a time.
import { definePluginApp } from "@bb/plugin-sdk/app";

const PENDING_URL = "/api/v1/plugins/notify/http/pending";
const ACK_URL = "/api/v1/plugins/notify/http/ack";
const OPEN_URL = "/api/v1/plugins/notify/http/open";
/** Only one window may poll; the rest wait behind this lock. */
const POLL_LOCK = "bb-plugin-notify:poller";
/** Backoff after a failed poll, so a server restart is not hammered. */
const RETRY_DELAY_MS = 3_000;
/**
 * Floor between two empty polls. The server holds the request open, so an
 * empty batch should never come back fast; if one does — a proxy that will not
 * hold, a route answering 200 with nothing — this keeps the loop from becoming
 * a spin. A batch with notifications in it re-polls immediately, as it should.
 */
const MIN_EMPTY_POLL_MS = 1_000;

interface PendingNotification {
  id: number;
  title: string;
  body: string;
  threadId: string | null;
  silent: boolean;
}

function isPending(value: unknown): value is PendingNotification {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "number" &&
    typeof item.title === "string" &&
    typeof item.body === "string" &&
    typeof item.silent === "boolean" &&
    (item.threadId === null || typeof item.threadId === "string")
  );
}

/** Wait, cut short by abort. Each path disarms the other, so `finish` runs once. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      // oxlint-disable-next-line promise/no-multiple-resolved
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Route to the thread the notification came from.
 *
 * BB's own open action is asked first: it is what `bb thread open` runs, so it
 * resolves the thread's project, picks the pane, and focuses the window — none
 * of which this script could work out from a thread id. The DOM and URL
 * fallbacks exist only for a request that never reached the server; a thread
 * the server actively refuses to open is not worth guessing about.
 */
async function openThread(threadId: string): Promise<void> {
  try {
    const response = await fetch(OPEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId }),
      credentials: "same-origin",
    });
    if (response.ok) return;
    // The server answered and declined — deleted thread, bad id.
    if (response.status < 500) return;
  } catch {
    // Transport failure: fall through and try to navigate locally.
  }
  const row = document.querySelector<HTMLElement>(
    `[data-sidebar-thread-id="${CSS.escape(threadId)}"]`,
  );
  if (row !== null) {
    row.click();
    return;
  }
  window.location.assign(`/threads/${encodeURIComponent(threadId)}`);
}

function present(item: PendingNotification): void {
  // `tag` collapses repeats about one thread into a single notification.
  // `silent` is the only sound control the web API has; a named tone is played
  // by the server alongside a silenced notification.
  const notification = new Notification(item.title, {
    body: item.body,
    tag: item.threadId ?? `bb-notify-${item.id}`,
    silent: item.silent,
  });
  notification.addEventListener("click", () => {
    window.focus();
    if (item.threadId !== null) void openThread(item.threadId);
    notification.close();
  });
}

async function acknowledge(
  leaseId: string,
  notificationIds: readonly number[],
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(ACK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leaseId, notificationIds }),
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

async function poll(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const startedAt = Date.now();
    try {
      const response = await fetch(PENDING_URL, {
        signal,
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: unknown = await response.json();
      const record =
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>)
          : null;
      const list = Array.isArray(record?.notifications)
        ? record.notifications
        : [];
      const leaseId = typeof record?.leaseId === "string" ? record.leaseId : null;
      if (list.length > 0 && leaseId === null) {
        throw new Error("notification batch has no lease");
      }
      let shown = 0;
      const shownIds: number[] = [];
      for (const item of list) {
        if (!isPending(item)) continue;
        try {
          present(item);
          shown += 1;
          shownIds.push(item.id);
        } catch {
          // A failed item remains leased and is retried later; the rest of the
          // batch can still be acknowledged independently.
        }
      }
      if (leaseId !== null && shownIds.length > 0) {
        await acknowledge(leaseId, shownIds, signal);
      }
      if (shown === 0 && Date.now() - startedAt < MIN_EMPTY_POLL_MS) {
        await sleep(MIN_EMPTY_POLL_MS, signal);
      }
    } catch {
      if (signal.aborted) return;
      await sleep(RETRY_DELAY_MS, signal);
    }
  }
}

async function bridge(signal: AbortSignal): Promise<void> {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
  if (Notification.permission !== "granted") return;

  if (navigator.locks === undefined) {
    await poll(signal);
    return;
  }
  // The lock elects a single poller across windows, and hands over
  // automatically when that window closes.
  await navigator.locks.request(POLL_LOCK, { signal }, () => poll(signal));
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "notification-bridge",
    mount({ signal }) {
      // Detached on purpose: the host time-boxes awaited mount work, and this
      // bridge runs for the lifetime of the window.
      void bridge(signal).catch(() => {
        // A dead bridge must not take the app's plugin surface down with it.
      });
    },
  });
});
