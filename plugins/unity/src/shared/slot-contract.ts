import { z } from "zod";

export const slotSchema = z
  .object({
    id: z.string(),
    hostId: z.string(),
    workspacePath: z.string(),
    projectId: z.string(),
    state: z.enum(["available", "preparing", "leased", "releasing", "quarantined", "retired"]),
    ownerThreadId: z.string().nullable(),
    leaseId: z.string().nullable().optional(),
    reason: z.string().nullable(),
    updatedAt: z.string(),
  })
  .strict();

export const slotInputs = z.object({ slotId: z.string().min(1) }).strict();
export const slotResource = z
  .object({
    slotId: z.string().min(1),
    hostId: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();

export const slotActionSchema = z
  .object({
    action: z.enum(["list", "register", "acquire", "release", "recover", "retire"]),
    hostId: z.string().optional(),
    projectId: z.string().optional(),
    path: z.string().optional(),
    slotId: z.string().optional(),
    leaseId: z.string().optional(),
    note: z.string().optional(),
    confirmNoPendingWork: z.boolean().default(false),
  })
  .strict();
