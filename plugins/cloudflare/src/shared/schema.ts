import { z } from "zod";

export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const shareIdSchema = z.uuid();
export const specSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    allowedEmails: z
      .array(z.email().max(254))
      .min(1)
      .max(100)
      .transform((values) => [...new Set(values.map((value) => value.toLowerCase()))].sort()),
    identityProviderId: idSchema,
  })
  .strict();
export const createSchema = z
  .object({
    id: shareIdSchema,
    zoneId: idSchema,
    hostname: z
      .string()
      .max(253)
      .toLowerCase()
      .refine(
        (value) => value.split(".").every((label) => label.length <= 63),
        "Hostname labels must have at most 63 characters",
      )
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
    hostId: idSchema,
    spec: specSchema,
  })
  .strict();
export const updateSchema = z
  .object({ id: shareIdSchema, expectedRevision: z.number().int().positive(), spec: specSchema })
  .strict();
export const shareInputSchema = z
  .object({ id: shareIdSchema, expectedRevision: z.number().int().positive() })
  .strict();
export const resourcesSchema = z
  .object({
    tunnelId: idSchema.optional(),
    appId: idSchema.optional(),
    policyId: idSchema.optional(),
    dnsId: idSchema.optional(),
  })
  .strict();
export const shareSchema = z
  .object({
    id: shareIdSchema,
    accountId: idSchema,
    zoneId: idSchema,
    hostname: z.string(),
    hostId: idSchema,
    desiredSpec: specSchema,
    appliedSpec: specSchema.optional(),
    desiredState: z.enum(["running", "stopped", "removed"]),
    revision: z.number().int(),
    resources: resourcesSchema,
    pendingOperation: z.enum(["tunnel", "app", "policy", "dns"]).optional(),
    state: z.enum([
      "configuring",
      "starting",
      "running",
      "stopped",
      "partial",
      "removing",
      "removed",
    ]),
    lastError: z.string().optional(),
    updatedAt: z.string(),
  })
  .strict();
export const section = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), error: z.string().optional() }).strict();
export const oauthStatusSchema = z
  .object({
    configured: z.boolean(),
    connected: z.boolean(),
    accountId: z.string(),
    clientId: z.string(),
    redirectUri: z.string(),
    missing: z.array(z.string()),
    expiresAt: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
export const oauthConnectSchema = z.object({ authorizationUrl: z.url() }).strict();
export const oauthDisconnectSchema = z
  .object({ ok: z.literal(true), message: z.string() })
  .strict();
export const overviewSchema = z
  .object({
    setup: z
      .object({
        configured: z.boolean(),
        accountId: z.string(),
        missing: z.array(z.string()),
        permissions: z.array(z.string()),
        oauth: oauthStatusSchema,
      })
      .strict(),
    shares: z.array(shareSchema),
    hosts: section(z.object({ id: z.string(), name: z.string(), online: z.boolean() }).strict()),
    zones: section(z.object({ id: z.string(), name: z.string() }).strict()),
    dnsRecords: section(
      z
        .object({
          id: z.string(),
          zoneId: z.string(),
          zoneName: z.string(),
          name: z.string(),
          type: z.string(),
          content: z.string(),
          proxied: z.boolean().optional(),
          ttl: z.number().optional(),
          tunnelId: z.string().optional(),
        })
        .strict(),
    ),
    identityProviders: section(
      z.object({ id: z.string(), name: z.string(), type: z.string() }).strict(),
    ),
    tunnels: section(
      z
        .object({
          id: z.string(),
          name: z.string(),
          status: z.string(),
          configSource: z.string(),
          connections: z.number(),
          connectionError: z.string().optional(),
          dnsTarget: z.string(),
          publicHostnames: z.array(
            z
              .object({
                hostname: z.string(),
                url: z.url().optional(),
                source: z.enum(["dns", "ingress", "dns+ingress"]),
              })
              .strict(),
          ),
          hostnameError: z.string().optional(),
        })
        .strict(),
    ),
    apps: section(
      z
        .object({
          id: z.string(),
          name: z.string(),
          domain: z.string(),
          type: z.string(),
          policyIds: z.array(z.string()),
        })
        .strict(),
    ),
    policies: section(
      z
        .object({
          id: z.string(),
          name: z.string(),
          decision: z.string(),
          allowedEmails: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();
export const resultSchema = z
  .object({ share: shareSchema, ok: z.boolean(), message: z.string() })
  .strict();
export type Share = z.infer<typeof shareSchema>;
export type Spec = z.infer<typeof specSchema>;
export type CreateShare = z.infer<typeof createSchema>;
export type Overview = z.infer<typeof overviewSchema>;
export type ShareResult = z.infer<typeof resultSchema>;
export type OAuthStatus = z.infer<typeof oauthStatusSchema>;
