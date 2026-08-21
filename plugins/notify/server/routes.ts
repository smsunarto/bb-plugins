// The HTTP surface the app window drives: a held long-poll for pending
// notifications, the acknowledgement that releases a lease, and the click
// handler that opens a thread.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { Context } from "./context.ts";
import { isThreadId } from "./format.ts";
import { QUEUE_MAX } from "./queue.ts";

/** How long a long-poll is held open before returning an empty batch. */
const POLL_HOLD_MS = 25_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function registerRoutes(bb: BbPluginApi, context: Context): void {
  bb.http.route("GET", "/pending", async (c) => {
    const { signal } = c.req.raw;
    context.markPoll();
    let delivery = await context.notifications.lease();
    if (delivery.lease === null) {
      const holdMs = Math.min(POLL_HOLD_MS, delivery.retryAfterMs ?? POLL_HOLD_MS);
      await context.waitForQueue(signal, holdMs);
      // Do not acquire a lease for a response whose client has already gone.
      if (signal.aborted) {
        return c.json({ leaseId: null, notifications: [] });
      }
      delivery = await context.notifications.lease();
    }
    context.markPoll();
    return c.json({
      leaseId: delivery.lease?.id ?? null,
      notifications: delivery.lease?.notifications ?? [],
    });
  });

  bb.http.route("POST", "/ack", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const leaseId = isRecord(body) ? body.leaseId : undefined;
    const notificationIds = isRecord(body) ? body.notificationIds : undefined;
    if (
      typeof leaseId !== "string" ||
      leaseId === "" ||
      leaseId.length > 128 ||
      !Array.isArray(notificationIds) ||
      notificationIds.length > QUEUE_MAX ||
      notificationIds.some((id) => !Number.isSafeInteger(id) || (id as number) < 1)
    ) {
      return c.json({ ok: false, error: "invalid acknowledgement" }, 400);
    }
    const result = await context.notifications.acknowledge(leaseId, notificationIds as number[]);
    const sound = result.play;
    if (sound !== null) {
      context.queueSound(sound);
    }
    return c.json({ ok: true, acknowledged: result.acknowledged });
  });

  // Clicking a notification routes through BB's own open action — the same one
  // `bb thread open` uses — so the thread lands in the right project and pane
  // instead of the window guessing at a URL.
  bb.http.route("POST", "/open", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const threadId =
      typeof body === "object" && body !== null
        ? (body as { threadId?: unknown }).threadId
        : undefined;
    if (typeof threadId !== "string" || !isThreadId(threadId)) {
      return c.json({ ok: false, error: "invalid threadId" }, 400);
    }
    try {
      await bb.sdk.threads.open({ threadId, file: null });
      return c.json({ ok: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      bb.log.warn(`open ${threadId} failed: ${detail}`);
      return c.json({ ok: false, error: detail }, 502);
    }
  });
}
