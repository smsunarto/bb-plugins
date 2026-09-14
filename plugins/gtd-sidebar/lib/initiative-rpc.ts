// The initiative RPC boundary: the zod contract the frontend calls and the
// handlers that bridge it onto the domain service, store, and subscription
// engine. Registered as a second contract beside gtdSidebarRpcContract so
// server.ts stays a one-line integration.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { buildContextTree, type InitiativeStore } from "./initiative-store.ts";
import {
  githubCiConfigSchema,
  githubPrConfigSchema,
  slackChannelConfigSchema,
  subscriptionScheduleConfigSchema,
} from "./initiative-subscriptions.ts";
import type { InitiativeContextDoc } from "./initiative-types.ts";
import type { InitiativeRuntime } from "./initiative-runtime.ts";

const initiativeWorkspaceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("legacy") }),
  z.object({
    mode: z.literal("shared-directory"),
    hostId: z.string().trim().min(1),
    rootPath: z.string().trim().min(1),
  }),
]);

const sharedDirectoryLocationSchema = z.object({
  hostId: z.string(),
  hostName: z.string(),
  rootPath: z.string(),
});

const sharedDirectoryPreviewErrorSchema = z.object({
  code: z.enum([
    "not-enough-repositories",
    "too-many-repositories",
    "duplicate-project",
    "project-not-found",
    "source-missing",
    "source-ambiguous",
    "cross-host",
    "duplicate-path",
    "root-missing",
    "root-not-directory",
    "invalid-path",
    "unsafe-root",
    "outside-root",
    "host-unavailable",
  ]),
  message: z.string(),
  projectId: z.string().optional(),
  path: z.string().optional(),
});

const sharedDirectoryWorkspacePreviewSchema = z.object({
  eligible: z.boolean(),
  suggested: sharedDirectoryLocationSchema.nullable(),
  selection: sharedDirectoryLocationSchema.nullable(),
  repositories: z.array(
    z.object({
      projectId: z.string(),
      name: z.string(),
      hostId: z.string().nullable(),
      path: z.string().nullable(),
    }),
  ),
  errors: z.array(sharedDirectoryPreviewErrorSchema),
});

const reasoningLevelSchema = z.enum([
  "high",
  "low",
  "max",
  "medium",
  "none",
  "ultra",
  "ultracode",
  "xhigh",
]);

const initiativeSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  description: z.string(),
  coordinatorThreadId: z.string(),
  workspaceProjectIds: z.array(z.string()),
  workspace: initiativeWorkspaceSchema,
  primaryEnvironmentId: z.string().nullable(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullable(),
});

const initiativeAgentSchema = z.object({
  threadId: z.string(),
  initiativeId: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  depth: z.number(),
  createdAt: z.number(),
});

const contextDocSchema: z.ZodType<InitiativeContextDoc> = z.lazy(() =>
  z.object({
    path: z.string(),
    kind: z.enum(["file", "directory"]),
    sizeBytes: z.number(),
    revision: z.number(),
    updatedAt: z.number(),
    children: z.array(contextDocSchema).optional(),
  }),
);

const initiativeEnvironmentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string().nullable(),
  status: z.enum(["creating", "provisioning", "ready", "error", "destroyed"]),
  hostId: z.string(),
  path: z.string().nullable(),
  branchName: z.string().nullable(),
  isWorktree: z.boolean(),
  environmentProviderId: z.string().nullable(),
});

const environmentProviderSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  pluginId: z.string(),
  available: z.boolean(),
});

const subscriptionSchema = z.object({
  id: z.string(),
  initiativeId: z.string(),
  kind: z.enum(["schedule", "github-ci", "github-pr", "slack-channel"]),
  label: z.string(),
  prompt: z.string().nullable(),
  config: z
    .union([
      subscriptionScheduleConfigSchema,
      githubCiConfigSchema,
      githubPrConfigSchema,
      slackChannelConfigSchema,
    ])
    .nullable(),
  configError: z.string().nullable(),
  enabled: z.boolean(),
  pollIntervalMs: z.number().nullable(),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  lastStatus: z
    .enum(["ok", "quiet", "baseline", "error", "rate_limited", "delivery_error", "invalid_config"])
    .nullable(),
  lastError: z.string().nullable(),
  cursor: z.string().nullable(),
  retryAfterUntil: z.number().nullable(),
  deliveryAttempts: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const initiativeIdSchema = z.object({ initiativeId: z.string().trim().min(1) });

const executionDefaultsSchema = {
  providerId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  reasoningLevel: reasoningLevelSchema.nullable().optional(),
};

const environmentSelectionSchema = {
  environmentId: z
    .string()
    .nullable()
    .optional()
    .describe("Reuse an existing environment; wins over environmentProviderId."),
  environmentProviderId: z
    .string()
    .nullable()
    .optional()
    .describe("Provision a fresh environment through this provider."),
};

export const initiativeRpcContract = defineRpcContract({
  previewInitiativeWorkspace: {
    input: z.object({
      workspaceProjectIds: z.array(z.string().trim().min(1)),
      candidate: z
        .object({
          hostId: z.string().trim().min(1).optional(),
          rootPath: z.string().trim().min(1).optional(),
        })
        .nullable()
        .optional(),
    }),
    output: sharedDirectoryWorkspacePreviewSchema,
  },
  listInitiatives: {
    input: z.object({ workspaceProjectId: z.string().optional() }),
    output: z.object({ initiatives: z.array(initiativeSchema) }),
  },
  getInitiative: {
    input: initiativeIdSchema,
    output: z.object({
      initiative: initiativeSchema,
      agents: z.array(initiativeAgentSchema),
      /** True when the roster hit the cap — never render it as complete. */
      truncated: z.boolean(),
      coordinatorStatus: z.string().nullable(),
      coordinatorAvailable: z.boolean(),
    }),
  },
  initiativeForThread: {
    input: z.object({ threadId: z.string().trim().min(1) }),
    output: z.object({
      initiative: initiativeSchema.nullable(),
      role: z.enum(["coordinator", "agent"]).nullable(),
    }),
  },
  createInitiative: {
    input: z.object({
      name: z.string().trim().min(1),
      icon: z.string().optional(),
      description: z.string().optional(),
      /** Bound bb repository projects; empty = from scratch (personal). */
      workspaceProjectIds: z.array(z.string().trim().min(1)).max(32),
      workspace: initiativeWorkspaceSchema.optional(),
      ...environmentSelectionSchema,
      ...executionDefaultsSchema,
      initialPrompt: z.string().optional(),
    }),
    output: z.object({ initiative: initiativeSchema, threadId: z.string() }),
  },
  updateInitiative: {
    input: initiativeIdSchema.extend({
      name: z.string().trim().min(1).optional(),
      icon: z.string().optional(),
      description: z.string().optional(),
      workspaceProjectIds: z.array(z.string().trim().min(1)).max(32).optional(),
      ...executionDefaultsSchema,
    }),
    output: z.object({ initiative: initiativeSchema }),
  },
  archiveInitiative: {
    input: initiativeIdSchema,
    output: z.object({ ok: z.literal(true) }),
  },
  unarchiveInitiative: {
    input: initiativeIdSchema,
    output: z.object({ initiative: initiativeSchema }),
  },
  deleteInitiative: {
    input: initiativeIdSchema,
    output: z.object({ ok: z.literal(true) }),
  },
  attachInitiativeThread: {
    input: initiativeIdSchema.extend({ threadId: z.string().trim().min(1) }),
    output: z.object({ ok: z.literal(true) }),
  },
  detachInitiativeThread: {
    input: initiativeIdSchema.extend({ threadId: z.string().trim().min(1) }),
    output: z.object({ ok: z.literal(true) }),
  },
  spawnInitiativeAgent: {
    input: z.object({
      initiativeId: z.string().trim().min(1),
      prompt: z.string().min(1),
      title: z.string().optional(),
      projectId: z.string().optional(),
      ...environmentSelectionSchema,
      ...executionDefaultsSchema,
    }),
    output: z.object({ threadId: z.string() }),
  },
  listInitiativeEnvironments: {
    input: z.object({ projectId: z.string().trim().min(1) }),
    output: z.object({ environments: z.array(initiativeEnvironmentSchema) }),
  },
  listEnvironmentProviders: {
    input: z.object({ projectId: z.string().optional() }),
    output: z.object({ providers: z.array(environmentProviderSchema) }),
  },
  listContextDocs: {
    input: initiativeIdSchema,
    output: z.object({ docs: z.array(contextDocSchema) }),
  },
  readContextDoc: {
    input: initiativeIdSchema.extend({ path: z.string().min(1) }),
    output: z.object({
      path: z.string(),
      content: z.string(),
      revision: z.number(),
    }),
  },
  writeContextDoc: {
    input: initiativeIdSchema.extend({
      path: z.string().min(1),
      content: z.string(),
      /** Omit for an unconditional upsert; 0 = create-only; n = guarded overwrite. */
      expectedRevision: z.number().int().min(0).optional(),
    }),
    output: z.object({
      outcome: z.enum(["written", "conflict"]),
      revision: z.number(),
    }),
  },
  deleteContextDoc: {
    input: initiativeIdSchema.extend({ path: z.string().min(1) }),
    output: z.object({ ok: z.literal(true), deletedCount: z.number() }),
  },
  listSubscriptions: {
    input: initiativeIdSchema,
    output: z.object({ subscriptions: z.array(subscriptionSchema) }),
  },
  upsertSubscription: {
    input: z.object({
      subscriptionId: z.string().optional(),
      initiativeId: z.string().trim().min(1),
      kind: z.enum(["schedule", "github-ci", "github-pr", "slack-channel"]),
      label: z.string().trim().min(1),
      prompt: z.string().nullable().optional(),
      config: z.record(z.string(), z.unknown()),
      enabled: z.boolean().optional(),
      pollIntervalMs: z.number().int().min(30_000).optional(),
    }),
    output: z.object({ subscription: subscriptionSchema }),
  },
  deleteSubscription: {
    input: z.object({ subscriptionId: z.string().trim().min(1) }),
    output: z.object({ ok: z.literal(true) }),
  },
  runSubscriptionNow: {
    input: z.object({ subscriptionId: z.string().trim().min(1) }),
    output: z.object({ ok: z.literal(true) }),
  },
});

const requireInitiative = (store: InitiativeStore, initiativeId: string) => {
  const initiative = store.get(initiativeId);
  if (initiative === null) throw new Error(`initiative ${initiativeId} not found`);
  return initiative;
};

export function registerInitiativeRpc(bb: BbPluginApi, runtime: InitiativeRuntime): void {
  const { store, service, subscriptionStore, engine } = runtime;
  bb.rpc.register(initiativeRpcContract, {
    previewInitiativeWorkspace(input) {
      return service.previewInitiativeWorkspace(input);
    },
    listInitiatives({ workspaceProjectId }) {
      return { initiatives: store.list({ workspaceProjectId }) };
    },
    async getInitiative({ initiativeId }) {
      const initiative = requireInitiative(store, initiativeId);
      const [{ agents, truncated }, snapshot] = await Promise.all([
        service.listAgents(initiative),
        service.coordinatorSnapshot(initiative),
      ]);
      return {
        initiative,
        agents,
        truncated,
        coordinatorStatus: snapshot.status,
        coordinatorAvailable: snapshot.available,
      };
    },
    async initiativeForThread({ threadId }) {
      return (await service.resolveThread(threadId)) ?? { initiative: null, role: null };
    },
    async createInitiative(input) {
      return service.createInitiative(input);
    },
    updateInitiative({ initiativeId, ...patch }) {
      return { initiative: service.updateInitiative(initiativeId, patch) };
    },
    async archiveInitiative({ initiativeId }) {
      await service.setArchived(initiativeId, true);
      return { ok: true as const };
    },
    async unarchiveInitiative({ initiativeId }) {
      return { initiative: await service.setArchived(initiativeId, false) };
    },
    deleteInitiative({ initiativeId }) {
      requireInitiative(store, initiativeId);
      engine.removeForInitiative(initiativeId);
      service.deleteInitiative(initiativeId);
      return { ok: true as const };
    },
    async attachInitiativeThread({ initiativeId, threadId }) {
      await service.attachThread(initiativeId, threadId);
      return { ok: true as const };
    },
    async detachInitiativeThread({ initiativeId, threadId }) {
      await service.detachThread(initiativeId, threadId);
      return { ok: true as const };
    },
    async spawnInitiativeAgent(input) {
      return service.spawnAgent(input);
    },
    async listInitiativeEnvironments({ projectId }) {
      const environments = await bb.sdk.environments.list({ projectId });
      return {
        environments: environments.map((environment) => ({
          id: environment.id,
          projectId: environment.projectId,
          name: environment.name,
          status: environment.status,
          hostId: environment.hostId,
          path: environment.path,
          branchName: environment.branchName,
          isWorktree: environment.isWorktree,
          environmentProviderId: environment.environmentProviderId,
        })),
      };
    },
    async listEnvironmentProviders({ projectId }) {
      const providers = await bb.sdk.environments.listProviders(
        projectId === undefined ? {} : { projectId },
      );
      return {
        providers: providers.map((provider) => ({
          id: provider.id,
          displayName: provider.displayName,
          description: provider.description,
          icon: provider.icon,
          pluginId: provider.pluginId,
          available: provider.availability?.status === "available",
        })),
      };
    },
    listContextDocs({ initiativeId }) {
      requireInitiative(store, initiativeId);
      return { docs: buildContextTree(store.listDocs(initiativeId)) };
    },
    readContextDoc({ initiativeId, path }) {
      requireInitiative(store, initiativeId);
      const doc = store.getDoc(initiativeId, path);
      if (doc === null) throw new Error(`context doc ${JSON.stringify(path)} not found`);
      return { path: doc.path, content: doc.content, revision: doc.revision };
    },
    writeContextDoc({ initiativeId, path, content, expectedRevision }) {
      requireInitiative(store, initiativeId);
      return service.writeContextDoc({
        initiativeId,
        path,
        content,
        expectedRevision,
        updatedBy: "user",
      });
    },
    deleteContextDoc({ initiativeId, path }) {
      requireInitiative(store, initiativeId);
      return { ok: true as const, deletedCount: service.deleteContextDoc(initiativeId, path) };
    },
    listSubscriptions({ initiativeId }) {
      requireInitiative(store, initiativeId);
      return { subscriptions: subscriptionStore.list(initiativeId) };
    },
    upsertSubscription(input) {
      requireInitiative(store, input.initiativeId);
      if (input.subscriptionId !== undefined) {
        // Ownership before mutation — the engine's upsert itself is not
        // initiative-aware.
        const existing = subscriptionStore.get(input.subscriptionId);
        if (existing === null || existing.initiativeId !== input.initiativeId) {
          throw new Error(`subscription ${input.subscriptionId} not found in this project`);
        }
      }
      return { subscription: engine.upsertSubscription(input) };
    },
    deleteSubscription({ subscriptionId }) {
      // The engine's delete path publishes the realtime refresh; a bare
      // store.remove would leave every open subscription tray stale.
      engine.deleteSubscription(subscriptionId);
      return { ok: true as const };
    },
    async runSubscriptionNow({ subscriptionId }) {
      await engine.runNow(subscriptionId);
      return { ok: true as const };
    },
  });
}
