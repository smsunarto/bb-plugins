import { z } from "zod";

export const saveInput = z
  .object({
    id: z.uuid(),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20000),
    sourceThreadId: z
      .string()
      .regex(/^thr_[a-zA-Z0-9]+$/)
      .nullable()
      .default(null),
  })
  .strict();

export const reminderSchema = saveInput.extend({ createdAt: z.string() });
export type Reminder = z.infer<typeof reminderSchema>;
export type SaveInput = z.infer<typeof saveInput>;

export function reminderText(reminder: Reminder): string {
  return `${reminder.title}\n\n${reminder.body}${reminder.sourceThreadId ? `\n\nSource: @thread:${reminder.sourceThreadId}` : ""}`;
}
