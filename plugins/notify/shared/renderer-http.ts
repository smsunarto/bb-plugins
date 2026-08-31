import { z } from "zod";

export const rendererHttpPaths = {
  next: "/mailbox/next",
  acknowledge: "/mailbox/ack",
  openThread: "/open",
} as const;

export type RendererHttpPath = (typeof rendererHttpPaths)[keyof typeof rendererHttpPaths];

export function rendererHttpUrl(pluginId: string, path: RendererHttpPath): string {
  return `/api/v1/plugins/${encodeURIComponent(pluginId)}/http${path}`;
}

export const threadIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);

export function isThreadId(value: unknown): value is string {
  return threadIdSchema.safeParse(value).success;
}

export const rendererNotificationSchema = z
  .object({
    title: z.string(),
    body: z.string(),
    threadId: threadIdSchema.nullable(),
    silent: z.boolean(),
  })
  .strict();

export type RendererNotification = Readonly<z.infer<typeof rendererNotificationSchema>>;

export const deliveryEnvelopeSchema = z
  .object({
    id: z.string().min(1).max(128),
    notification: rendererNotificationSchema,
  })
  .strict();

export type DeliveryEnvelope = Readonly<z.infer<typeof deliveryEnvelopeSchema>>;

export const rendererOutcomeSchema = z.enum(["shown", "suppressed", "failed"]);

export type RendererOutcome = z.infer<typeof rendererOutcomeSchema>;

export const rendererAckSchema = z
  .object({
    id: z.string().min(1).max(128),
    outcome: rendererOutcomeSchema,
  })
  .strict();

export type RendererAck = Readonly<z.infer<typeof rendererAckSchema>>;

export const openThreadSchema = z.object({ threadId: threadIdSchema }).strict();

export function parseDeliveryEnvelope(value: unknown): DeliveryEnvelope | null {
  const parsed = deliveryEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
