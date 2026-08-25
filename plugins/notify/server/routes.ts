import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { notificationQueue } from "./delivery.ts";
import { isThreadId } from "./format.ts";
import { QUEUE_MAX } from "./queue.ts";

export function registerRoutes(
  bb: BbPluginApi,
  queueSound: (name: string) => void,
): void {
  bb.http.route("GET", "/pending", async (c) => {
    const batch = await notificationQueue(bb).nextBatch(c.req.raw.signal);
    return c.json(batch);
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
    const result = await notificationQueue(bb).acknowledge(
      leaseId,
      notificationIds as number[],
    );
    if (result.play !== null) {
      queueSound(result.play);
    }
    return c.json({ ok: true, acknowledged: result.acknowledged });
  });

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
