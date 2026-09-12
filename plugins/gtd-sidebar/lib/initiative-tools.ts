// The agent surface of an initiative: native tools the coordinator and its
// descendants actually call, the per-resolution tool selection, and the
// dynamic instructions that tell each thread its role.
//
// Tool availability is decided synchronously in bb.agents.configure from the
// service's membership hints — coordinator gets the full delegation set,
// descendants get shared-context access. Registration itself is static; the
// selection is what differs per thread.
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { INITIATIVE_TOOL_NAMES, type Initiative, type InitiativeRole } from "./initiative-types.ts";
import type { InitiativeStore } from "./initiative-store.ts";
import type { InitiativeService } from "./initiative-service.ts";
import {
  githubCiConfigSchema,
  githubPrConfigSchema,
  slackChannelConfigSchema,
  subscriptionScheduleConfigSchema,
  type SubscriptionEngine,
  type SubscriptionStore,
} from "./initiative-subscriptions.ts";

type Threads = Pick<BbPluginApi["sdk"]["threads"], "send">;

export interface InitiativeAgentDeps {
  service: InitiativeService;
  store: InitiativeStore;
  /** The engine's upsert owns create-vs-update plus durable cursor init. */
  engine: Pick<SubscriptionEngine, "upsertSubscription" | "deleteSubscription" | "runNow">;
  /** Store reads back the upsert result and backs ownership checks. */
  subscriptions: Pick<SubscriptionStore, "get" | "list" | "remove">;
  threads: Threads;
  pluginId: string;
}

const json = (value: unknown): PluginAgentToolResult => JSON.stringify(value, null, 2);

const contextDocIndex = (store: InitiativeStore, initiativeId: string): string => {
  const docs = store.listDocs(initiativeId);
  if (docs.length === 0) return "  (no context documents yet)";
  return docs
    .slice(0, 24)
    .map((doc) => `  ${doc.path} (rev ${doc.revision})`)
    .join("\n");
};

const coordinatorInstructions = (initiative: Initiative, store: InitiativeStore): string => {
  const workspaces =
    initiative.workspaceProjectIds.length === 0
      ? "the personal project (created from scratch)"
      : initiative.workspaceProjectIds.join(", ");
  return [
    `You are the coordinator of the project "${initiative.name}" (${initiative.id}).`,
    `Own the outcome — never write code yourself. Decompose work and delegate with ${INITIATIVE_TOOL_NAMES.spawnAgent}; each agent runs in its own BB thread and environment, and its completion reaches you as a native child-thread notification. Track agents with ${INITIATIVE_TOOL_NAMES.listAgents} and steer them with ${INITIATIVE_TOOL_NAMES.messageAgent}.`,
    `Shared context documents are the project's memory: read them with ${INITIATIVE_TOOL_NAMES.contextRead}, list with ${INITIATIVE_TOOL_NAMES.contextList}, and write plans, decisions, and durable findings with ${INITIATIVE_TOOL_NAMES.contextWrite} — agents and the user see the same documents.`,
    `Subscriptions (${INITIATIVE_TOOL_NAMES.subscriptionUpsert}/${INITIATIVE_TOOL_NAMES.subscriptionDelete}/${INITIATIVE_TOOL_NAMES.subscriptionList}) deliver scheduled prompts and GitHub/Slack events into this conversation — use them for recurring checks instead of asking the user to come back.`,
    `Bound repositories: ${workspaces}. Spawn agents into any bound repository with projectId; choose an existing environment with environmentId or provision via environmentProviderId.`,
    initiative.description.length > 0 ? `Project brief: ${initiative.description}` : "",
    `Context documents:\n${contextDocIndex(store, initiative.id)}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, 4000);
};

const agentInstructions = (initiative: Initiative): string =>
  [
    `You are an agent for the project "${initiative.name}". Do the task you were given, then stop — your parent thread (the project coordinator) is notified when you finish.`,
    `Shared project documents live behind the ${INITIATIVE_TOOL_NAMES.contextList}/${INITIATIVE_TOOL_NAMES.contextRead}/${INITIATIVE_TOOL_NAMES.contextWrite} tools: read before assuming, and write durable findings back so the coordinator and sibling agents see them.`,
  ].join("\n");

export function registerInitiativeAgents(bb: BbPluginApi, deps: InitiativeAgentDeps): void {
  const { service, store, engine, subscriptions, threads } = deps;

  const resolve = async (threadId: string) => {
    const resolved = await service.resolveThread(threadId);
    if (resolved === null) throw new Error("this thread is not part of an initiative");
    return resolved;
  };

  const N = INITIATIVE_TOOL_NAMES;

  bb.agents.registerTool({
    name: N.spawnAgent,
    description:
      "Delegate a bounded task to a new agent thread under this project. The agent runs in the chosen bound repository/environment and reports back as a child thread.",
    parameters: z.object({
      prompt: z.string().min(1),
      title: z.string().optional(),
      projectId: z
        .string()
        .optional()
        .describe("One of the project's bound repositories; defaults to the primary binding."),
      environmentId: z
        .string()
        .optional()
        .describe("Reuse an existing environment id on that repository."),
      environmentProviderId: z
        .string()
        .optional()
        .describe("Provision a fresh environment through this provider."),
      providerId: z.string().optional(),
      model: z.string().optional(),
      reasoningLevel: z.string().optional(),
    }),
    async execute(params, ctx) {
      const { initiative } = await resolve(ctx.threadId);
      const { threadId } = await service.spawnAgent({
        initiativeId: initiative.id,
        prompt: params.prompt,
        title: params.title,
        projectId: params.projectId,
        environmentId: params.environmentId,
        environmentProviderId: params.environmentProviderId,
        providerId: params.providerId,
        model: params.model,
        reasoningLevel: params.reasoningLevel,
      });
      return json({ threadId });
    },
  });

  bb.agents.registerTool({
    name: N.listAgents,
    description: "List this project's agent threads with their live status.",
    parameters: z.object({}),
    async execute(_params, ctx) {
      const { initiative } = await resolve(ctx.threadId);
      const { agents, truncated } = await service.listAgents(initiative);
      return json({ agents, truncated });
    },
  });

  bb.agents.registerTool({
    name: N.messageAgent,
    description: "Send a steering message into one of this project's agent threads.",
    parameters: z.object({
      threadId: z.string().min(1),
      text: z.string().min(1),
    }),
    async execute(params, ctx) {
      const { initiative } = await resolve(ctx.threadId);
      const target = await service.resolveThread(params.threadId);
      if (target === null || target.initiative.id !== initiative.id) {
        throw new Error(`thread ${params.threadId} is not part of project ${initiative.id}`);
      }
      await threads.send({
        threadId: params.threadId,
        input: [{ type: "text", text: params.text, mentions: [] }],
        mode: "auto",
        senderThreadId: ctx.threadId,
      });
      return json({ ok: true });
    },
  });

  bb.agents.registerTool({
    name: N.contextList,
    description:
      "List the project's shared context documents (path, revision). These are the project memory shared by the coordinator, every agent, and the user.",
    parameters: z.object({}),
    async execute(_params, ctx) {
      const { initiative } = await resolve(ctx.threadId);
      return json({ docs: store.listDocs(initiative.id) });
    },
  });

  bb.agents.registerTool({
    name: N.contextRead,
    description: "Read a shared context document by path; returns content and current revision.",
    parameters: z.object({ path: z.string().min(1) }),
    async execute(params, ctx) {
      const { initiative } = await resolve(ctx.threadId);
      const doc = store.getDoc(initiative.id, params.path);
      if (doc === null) throw new Error(`context doc ${JSON.stringify(params.path)} not found`);
      return json({ path: doc.path, content: doc.content, revision: doc.revision });
    },
  });

  bb.agents.registerTool({
    name: N.contextWrite,
    description:
      "Write a shared context document. expectedRevision is required: 0 = create-only, the live revision = guarded overwrite. A conflict result means re-read before retrying — parallel agents share these documents.",
    parameters: z.object({
      path: z.string().min(1),
      content: z.string(),
      expectedRevision: z.number().int().min(0),
    }),
    async execute(params, ctx) {
      const { initiative, role } = await resolve(ctx.threadId);
      const result = service.writeContextDoc({
        initiativeId: initiative.id,
        path: params.path,
        content: params.content,
        expectedRevision: params.expectedRevision,
        updatedBy: `${role}:${ctx.threadId}`,
      });
      return json(result);
    },
  });

  bb.agents.registerTool({
    name: N.contextDelete,
    description: "Delete a shared context document, or a whole directory prefix.",
    parameters: z.object({ path: z.string().min(1) }),
    async execute(params, ctx) {
      const { initiative } = await resolve(ctx.threadId);
      const deletedCount = service.deleteContextDoc(initiative.id, params.path);
      return json({ ok: true, deletedCount });
    },
  });

  bb.agents.registerTool({
    name: N.subscriptionList,
    description: "List this project's subscriptions (scheduled wake-ups and event feeds).",
    parameters: z.object({}),
    async execute(_params, ctx) {
      const { initiative } = await resolve(ctx.threadId);
      return json({ subscriptions: subscriptions.list(initiative.id) });
    },
  });

  bb.agents.registerTool({
    name: N.subscriptionUpsert,
    description:
      "Create or update a subscription: kind 'schedule' wakes this conversation on a cron expression or once at a timestamp; 'github-ci', 'github-pr', and 'slack-channel' poll and digest events into this conversation.",
    parameters: z.object({
      subscriptionId: z.string().optional(),
      kind: z.enum(["schedule", "github-ci", "github-pr", "slack-channel"]),
      label: z.string().trim().min(1),
      prompt: z
        .string()
        .optional()
        .describe(
          "Instruction delivered with the digest (schedule configs carry their own prompt).",
        ),
      // The union of the real config schemas shows the model each kind's
      // required fields; parseSubscriptionConfig in the engine stays the
      // authoritative kind↔config check on the result.
      config: z
        .union([
          subscriptionScheduleConfigSchema,
          githubCiConfigSchema,
          githubPrConfigSchema,
          slackChannelConfigSchema,
        ])
        .describe(
          "Config matching kind — schedule: {schedule:'cron',expression,prompt} or {schedule:'once',runAt,prompt}; github-ci: {repo:'owner/repo',environmentId,branch?,catchUp?}; github-pr: {repo:'owner/repo',pr,environmentId,catchUp?}; slack-channel: {channelId,catchUp?}.",
        ),
      enabled: z.boolean().optional(),
      pollIntervalMs: z.number().int().min(30_000).optional(),
    }),
    async execute(params, ctx) {
      const { initiative } = await resolve(ctx.threadId);
      if (params.subscriptionId !== undefined) {
        // Ownership first: mutating another project's row must fail before
        // the engine's upsert touches anything.
        const existing = subscriptions.get(params.subscriptionId);
        if (existing === null || existing.initiativeId !== initiative.id) {
          throw new Error(`subscription ${params.subscriptionId} not found in this project`);
        }
      }
      const subscription = engine.upsertSubscription({
        subscriptionId: params.subscriptionId,
        initiativeId: initiative.id,
        kind: params.kind,
        label: params.label,
        prompt: params.prompt,
        config: params.config,
        enabled: params.enabled,
        pollIntervalMs: params.pollIntervalMs,
      });
      return json({ subscription });
    },
  });

  bb.agents.registerTool({
    name: N.subscriptionDelete,
    description: "Delete one of this project's subscriptions.",
    parameters: z.object({ subscriptionId: z.string().min(1) }),
    async execute(params, ctx) {
      const { initiative } = await resolve(ctx.threadId);
      const subscription = subscriptions.get(params.subscriptionId);
      if (subscription === null || subscription.initiativeId !== initiative.id) {
        throw new Error(`subscription ${params.subscriptionId} not found in this project`);
      }
      engine.deleteSubscription(subscription.id);
      return json({ ok: true });
    },
  });

  const COORDINATOR_TOOLS = [
    N.spawnAgent,
    N.listAgents,
    N.messageAgent,
    N.contextList,
    N.contextRead,
    N.contextWrite,
    N.contextDelete,
    N.subscriptionList,
    N.subscriptionUpsert,
    N.subscriptionDelete,
  ];
  const AGENT_TOOLS = [N.contextList, N.contextRead, N.contextWrite, N.contextDelete];

  bb.agents.configure((ctx) => {
    const role: InitiativeRole | null = service.membership.roleHint(
      ctx.thread.id,
      ctx.thread.parentThreadId,
    );
    if (role === "coordinator") return { tools: COORDINATOR_TOOLS, skills: [] };
    if (role === "agent") return { tools: AGENT_TOOLS, skills: [] };
    return { tools: [], skills: [] };
  });

  bb.agents.contributeInstructions(({ threadId }) => {
    const coordinated = store.getByCoordinator(threadId);
    if (coordinated !== null) return coordinatorInstructions(coordinated, store);
    const initiativeId = service.membership.descendantInitiative(threadId);
    if (initiativeId === null) return null;
    const initiative = store.get(initiativeId);
    return initiative === null ? null : agentInstructions(initiative);
  });

  bb.ui.registerMentionProvider({
    id: "initiative",
    label: "Projects",
    triggers: ["@"],
    search({ query }) {
      const needle = query.trim().toLowerCase();
      return store
        .list()
        .filter((initiative) => initiative.archivedAt === null)
        .filter(
          (initiative) =>
            needle.length === 0 ||
            initiative.name.toLowerCase().includes(needle) ||
            initiative.description.toLowerCase().includes(needle),
        )
        .slice(0, 10)
        .map((initiative) => ({
          id: initiative.id,
          title: `${initiative.icon} ${initiative.name}`.trim(),
          subtitle:
            initiative.workspaceProjectIds.length === 0
              ? "From scratch"
              : `${initiative.workspaceProjectIds.length} repositories`,
        }));
    },
    resolve(itemId) {
      const initiative = store.get(itemId);
      if (initiative === null) throw new Error(`project ${itemId} no longer exists`);
      const docs = store
        .listDocs(initiative.id)
        .slice(0, 20)
        .map((doc) => `- ${doc.path} (rev ${doc.revision})`);
      return {
        context: [
          `Project "${initiative.name}" (${initiative.id})`,
          initiative.description.length > 0 ? initiative.description : "",
          `Context documents:\n${docs.length > 0 ? docs.join("\n") : "(none)"}`,
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      };
    },
  });
}
