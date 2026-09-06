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

export const tunnelTargetSchema = z
  .object({
    accountId: idSchema,
    clientId: idSchema,
    tunnelId: idSchema,
  })
  .strict();
const routeFields = {
  hostname: z.string().min(1).max(253),
  path: z.string().max(2048).nullable(),
  service: z.string().min(1).max(4096),
};
export const routeDraftSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("existing"),
      originalIndex: z.number().int().nonnegative(),
      patch: z.object(routeFields).partial().strict(),
    })
    .strict(),
  z.object({ kind: z.literal("new"), ...routeFields }).strict(),
]);
export const tunnelEditSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("rename"),
      expectedName: z.string(),
      name: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .refine((value) => !/\p{Cc}/u.test(value), "Name cannot contain control characters"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("routes"),
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
      routes: z.array(routeDraftSchema).max(1000),
    })
    .strict(),
]);
export const editTunnelSchema = tunnelTargetSchema.extend({ edit: tunnelEditSchema }).strict();
export const originViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plain"), service: z.string() }).strict(),
  z.object({ kind: z.literal("private"), label: z.string() }).strict(),
]);
export const routeEditorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("editable"),
      revision: z.string(),
      version: z.number().optional(),
      advanced: z.boolean(),
      rules: z.array(
        z
          .object({
            originalIndex: z.number().int().nonnegative(),
            hostname: z.string(),
            path: z.string().nullable(),
            origin: originViewSchema,
            advanced: z.boolean(),
          })
          .strict(),
      ),
      fallback: originViewSchema,
      fallbackAdvanced: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("readonly"),
      reason: z.enum(["local", "unsupported", "share"]),
      message: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("unavailable"), message: z.string() }).strict(),
]);
export const connectorSchema = z
  .object({
    id: z.string().optional(),
    architecture: z.string().optional(),
    version: z.string().optional(),
    startedAt: z.string().optional(),
    configVersion: z.number().optional(),
    connections: z.array(
      z
        .object({
          id: z.string().optional(),
          colo: z.string().optional(),
          openedAt: z.string().optional(),
          originIp: z.string().optional(),
          version: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export const tunnelWriteStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }).strict(),
  z.object({ kind: z.literal("unconfirmed"), message: z.string() }).strict(),
]);
export const tunnelDetailsSchema = z
  .object({
    target: tunnelTargetSchema,
    name: z.string(),
    status: z.string(),
    configSource: z.string(),
    owner: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("account") }).strict(),
      z.object({ kind: z.literal("share"), shareId: z.string() }).strict(),
    ]),
    routes: routeEditorSchema,
    writeState: tunnelWriteStateSchema,
    connectors: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("ready"), value: z.array(connectorSchema) }).strict(),
      z.object({ kind: z.literal("unavailable"), message: z.string() }).strict(),
    ]),
    observedAt: z.string(),
  })
  .strict();
export const tunnelWriteResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("confirmed"), changed: z.boolean(), message: z.string() }).strict(),
  z
    .object({
      kind: z.literal("blocked"),
      reason: z.enum(["stale", "ownership", "source", "connection"]),
      message: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("rejected"), message: z.string() }).strict(),
  z.object({ kind: z.literal("unconfirmed"), message: z.string() }).strict(),
]);
export type TunnelTarget = z.infer<typeof tunnelTargetSchema>;
export type TunnelEdit = z.infer<typeof tunnelEditSchema>;
export type EditTunnel = z.infer<typeof editTunnelSchema>;
export type RouteDraft = z.infer<typeof routeDraftSchema>;
export type OriginView = z.infer<typeof originViewSchema>;
export type RouteEditor = z.infer<typeof routeEditorSchema>;
export type TunnelDetails = z.infer<typeof tunnelDetailsSchema>;
export type TunnelWriteResult = z.infer<typeof tunnelWriteResultSchema>;
export type Connector = z.infer<typeof connectorSchema>;

export type TunnelWriteState = z.infer<typeof tunnelWriteStateSchema>;
