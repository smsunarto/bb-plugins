import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const antigravityUsageWindowSchema = z
  .object({
    slot: z.enum(["primary", "secondary"]),
    windowMinutes: z.number().int().positive(),
    utilization: z.number().min(0).max(1),
    resetAt: z.number().int().nullable(),
  })
  .strict();

export type AntigravityUsageWindow = z.infer<typeof antigravityUsageWindowSchema>;

export const antigravityUsageProbeSchema = z
  .object({
    status: z.enum(["ok", "unauthenticated", "not_installed", "no_quota", "error"]),
    windows: z.array(antigravityUsageWindowSchema),
    message: z.string().nullable(),
  })
  .strict();

export type AntigravityUsageProbe = z.infer<typeof antigravityUsageProbeSchema>;

export const antigravityHostContract = defineRpcContract({
  "antigravity.loginStart": {
    input: z
      .object({
        profileId: z.string().uuid(),
        command: z.string().min(1).optional(),
      })
      .strict(),
    output: z
      .object({
        sessionId: z.string().uuid(),
        authorizeUrl: z.string().url(),
        profileHomeDir: z.string().min(1),
        geminiDir: z.string().min(1),
        appDataDir: z.string().min(1),
      })
      .strict(),
  },
  "antigravity.loginComplete": {
    input: z
      .object({
        sessionId: z.string().uuid(),
        pasted: z.string().min(1),
      })
      .strict(),
    output: z
      .object({
        profileHomeDir: z.string().min(1),
        geminiDir: z.string().min(1),
        appDataDir: z.string().min(1),
        usage: antigravityUsageProbeSchema,
      })
      .strict(),
  },
  "antigravity.loginCancel": {
    input: z
      .object({
        sessionId: z.string().uuid(),
      })
      .strict(),
    output: z
      .object({
        cancelled: z.boolean(),
      })
      .strict(),
  },
  "antigravity.probeUsage": {
    input: z
      .object({
        profileId: z.string().uuid(),
        command: z.string().min(1).optional(),
      })
      .strict(),
    output: antigravityUsageProbeSchema,
  },
  "antigravity.removeProfile": {
    input: z
      .object({
        profileId: z.string().uuid(),
      })
      .strict(),
    output: z
      .object({
        removed: z.boolean(),
      })
      .strict(),
  },
});
