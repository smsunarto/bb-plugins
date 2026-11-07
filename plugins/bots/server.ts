import { createHash, randomUUID } from "node:crypto";
import {
  defineCli,
  type BbPluginApi,
  type PluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import { z } from "zod";
import {
  BOT_TAGS,
  rpcContract,
  stateReadSchema,
  stateMutationSchema,
  stateMutationToolSchema,
  stateMutationResultSchema,
  normalizeStateMutation,
  type BotMetadata,
  type BotStateMutation,
} from "./contract.ts";
import { BOT_MIGRATIONS, createBotStore, EMPTY_HASHES, nextTimestamp } from "./lib/bot-store.ts";
import { startGtdImport } from "./lib/gtd-import.ts";
import {
  applyState,
  BotStateConflictError,
  createPrivateBotState,
  stateContent,
} from "./lib/private-state.ts";
import { memoryFacts, mutateStateDocument } from "./lib/state-actions.ts";
import { browseProjectDirectory, createWorkProject } from "./lib/project-creation.ts";
import { ensureHomeProject } from "./lib/home-project.ts";
import { createBotSkills } from "./lib/bot-skills.ts";
import { skillReadToolSchema, skillUpdateToolSchema } from "./lib/skill-schema.ts";
import { botsCliCommands } from "./lib/bots-cli.ts";
import { createWorkflowRuns } from "./lib/workflow-runs-server.ts";
import { handoffSourceFromText, handoffSourceThreadId } from "./lib/handoff-source.ts";
import { registerBotMentions } from "./lib/bot-mentions.ts";
import { listBotConversations } from "./lib/bot-conversations.ts";
import { botProjectContext } from "./lib/project-context.ts";
import { botGuidance, botInstructions, conversationStartText } from "./lib/bot-instructions.ts";
import { MEMORY_MAX_CHARS, validateMemory } from "./lib/memory-limit.ts";
import {
  createAutomationsClient,
  createRoutines,
  type StartRoutineConversation,
} from "./lib/routines.ts";
import { routineToolSchema, type RoutineFields } from "./lib/routine-schema.ts";
import { routineCliCommands } from "./lib/routines-cli.ts";
import {
  BOT_COMPLETION_SETTINGS,
  createCompletion,
  type CompletionSettingsSource,
} from "./lib/completion-server.ts";
import { BOT_MACHINE_SETTINGS, matchDefaultMachine } from "./lib/default-machine.ts";
import {
  ownedConversationProjectId,
  projectLaunchEnvironment,
  worktreeLaunchEnvironment,
} from "./lib/worktree-launch.ts";
import { createLastMessages } from "./lib/last-messages.ts";

/** The plugin settings the bots read: completion's plus the default machine. */
export interface BotSettingsSource {
  get(): Promise<
    Partial<
      Record<keyof typeof BOT_COMPLETION_SETTINGS | keyof typeof BOT_MACHINE_SETTINGS, unknown>
    >
  >;
  onChange(listener: () => void): unknown;
}

type SpawnRequest = Extract<
  Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0],
  { input: unknown }
>;

const START_MARKER = /^\[bb-bot-start:([a-f0-9-]{36})\]/;
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

/** The skill bound bot conversations load, from this plugin's `skills/bots`. */
const BOTS_SKILL = "bots";

/**
 * Bots: named specialists with private state and their conversations. GTD
 * Sidebar shows them on its Bots shelf while this plugin is enabled. Forked
 * from tobi/bb-bots-sidebar 1.1.0.
 */
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({ ...BOT_COMPLETION_SETTINGS, ...BOT_MACHINE_SETTINGS });
  bb.storage.migrate(bb.storage.database(), BOT_MIGRATIONS);
  const commands = registerBots(bb, settings);
  bb.cli.register(
    defineCli({
      name: "bots",
      summary: "List, create, and message bots.",
      usageErrorExitCode: 2,
      commands,
    }),
  );
  // Bots that GTD Sidebar stored before this plugin existed move here once.
  bb.onDispose(startGtdImport(bb, () => bb.rpc.experimental_invalidate([BOT_TAGS.bots])));
}

/**
 * Registers the bots' RPC, agent tools, hooks, and schedules. Expects
 * `BOT_MIGRATIONS` to have run on the plugin database. Returns the
 * `bb bots …` commands for the plugin's CLI registration.
 */
export function registerBots(
  bb: BbPluginApi,
  settings: BotSettingsSource & CompletionSettingsSource,
  automations = createAutomationsClient(bb),
) {
  const tools = instructionFiles(import.meta.url);
  const store = createBotStore(bb);
  const publish = () => bb.rpc.experimental_invalidate([BOT_TAGS.bots]);
  const state = createPrivateBotState(bb, store, publish);
  // Late-bound: workflow events reopen completions; completion asks for live runs.
  const workflowRuns = createWorkflowRuns(bb, (ownerThreadId) =>
    completion.reopenForActivity(ownerThreadId),
  );
  const completion = createCompletion(bb, store, publish, settings, workflowRuns.busyOwners);
  let personalId: string | null = null;
  const locks = new Map<string, Promise<unknown>>();
  function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    locks.set(key, run);
    void run
      .finally(() => {
        if (locks.get(key) === run) locks.delete(key);
      })
      .catch(() => {});
    return run;
  }
  async function personalProjectId() {
    if (personalId) return personalId;
    const project = (await bb.sdk.projects.list({ includePersonal: true })).find(
      (project) => project.kind === "personal",
    );
    if (!project) throw new Error("BB's personal project is unavailable");
    personalId = project.id;
    return personalId;
  }
  // Configuration may inspect a fork before its creation handler finishes.
  // Keep reads pure so they cannot preempt the atomic inherited bind + join.
  function owner(context: {
    id: string;
    parentThreadId?: string | null;
    sourceThreadId?: string | null;
  }) {
    const explicit = store.owner(context.id);
    if (explicit) return explicit;
    if (store.detached(context.id)) return null;
    const inherited =
      (context.parentThreadId && store.owner(context.parentThreadId)) ||
      (context.sourceThreadId && store.owner(context.sourceThreadId));
    return inherited || null;
  }
  async function resolveOwner(threadId: string, persist = true): Promise<string | null> {
    const chain: string[] = [];
    let current: string | null = threadId;
    let botId: string | null = null;
    while (current && !chain.includes(current)) {
      const explicit = store.owner(current);
      if (explicit) {
        botId = explicit;
        break;
      }
      if (store.detached(current)) break;
      const thread = await bb.sdk.threads.get({ threadId: current });
      chain.push(current);
      botId =
        (thread.parentThreadId && store.owner(thread.parentThreadId)) ||
        (thread.sourceThreadId && store.owner(thread.sourceThreadId)) ||
        null;
      if (botId) break;
      current = thread.parentThreadId ?? thread.sourceThreadId;
    }
    if (botId && persist) for (const id of chain) store.bind(id, botId);
    return botId;
  }
  async function validateLinks(ids: string[]) {
    if (new Set(ids).size !== ids.length) throw new Error("A project can only be linked once");
    const projects = await bb.sdk.projects.list();
    const botHomes = new Set(store.list().map((bot) => bot.homeProjectId));
    for (const id of ids) {
      if (
        !projects.some((project) => project.id === id && project.kind === "standard") ||
        botHomes.has(id)
      )
        throw new Error("Link an existing work project, not a bot home project");
    }
  }
  function validateSection(id: string | null) {
    if (id !== null && !store.sections().some((section) => section.id === id))
      throw new Error("Section no longer exists");
  }
  async function validateConversationProject(bot: BotMetadata, projectId: string) {
    if (
      projectId !== (await personalProjectId()) &&
      projectId !== bot.homeProjectId &&
      !bot.linkedProjectIds.includes(projectId)
    )
      throw new Error("Choose a projectless conversation or link this project to the bot first");
  }
  function saveBotIdentity({
    botId,
    expectedUpdatedAt,
    expectedStateHashes,
    ownedProjectIds,
    memory,
    settings,
    ...fields
  }: z.infer<typeof rpcContract.bot_update.input>) {
    return serial("registry", () =>
      serial(botId, async () => {
        const bot = await state.prepare(botId);
        if (bot.updatedAt !== expectedUpdatedAt)
          throw new Error(
            "Bot changed while editing. Reopen the editor or read identity again to avoid overwriting newer changes.",
          );
        if (JSON.stringify(fields.linkedProjectIds) !== JSON.stringify(bot.linkedProjectIds))
          await validateLinks(fields.linkedProjectIds);
        if (ownedProjectIds) {
          const existingOwned = new Set(store.ownedProjects(botId));
          await validateLinks(ownedProjectIds.filter((id) => !existingOwned.has(id)));
        }
        if (
          fields.hostId !== undefined &&
          fields.hostId !== bot.hostId &&
          !(await bb.sdk.hosts.list()).some((host) => host.id === fields.hostId)
        )
          throw new Error("Choose an enrolled execution machine");
        validateSection(fields.sectionId);
        const next = store.mutateWithProjects(
          botId,
          (current) => {
            if (current.updatedAt !== expectedUpdatedAt)
              throw new Error(
                "Bot changed while editing. Read the current identity before saving.",
              );
            let next = { ...current, ...fields };
            // A home lives on its machine; a new machine gets a new home on first use.
            if (next.hostId !== current.hostId) next.homeProjectId = null;
            if (memory !== undefined) next = applyState(next, "MEMORY.md", memory);
            if (settings !== undefined)
              next = applyState(
                next,
                "settings.json",
                stateContent({ ...next, settings }, "settings.json"),
              );
            for (const file of ["SOUL.md", "MEMORY.md", "settings.json"] as const) {
              if (stateContent(next, file) === stateContent(current, file)) continue;
              if (current.stateHashes[file] !== expectedStateHashes[file])
                throw new BotStateConflictError(
                  `${file} changed while editing. Read the current state before saving.`,
                );
            }
            return {
              ...next,
              stateHashes: {
                ...current.stateHashes,
                "SOUL.md": sha256(next.soul),
                ...(memory !== undefined ? { "MEMORY.md": sha256(next.memory) } : {}),
                ...(settings !== undefined
                  ? { "settings.json": sha256(stateContent(next, "settings.json")) }
                  : {}),
              },
              updatedAt: nextTimestamp(current.updatedAt),
            };
          },
          ownedProjectIds,
        );
        await state.mirror(next);
        publish();
        return next;
      }),
    );
  }
  async function updateProjectRole(
    botId: string,
    action: "join" | "leave" | "own" | "release",
    projectId: string,
  ) {
    return serial("registry", () =>
      serial(botId, async () => {
        store.require(botId);
        if (action === "join" || action === "own") await validateLinks([projectId]);
        const result = store.changeProjectRole(botId, projectId, action);
        if (result.changed) {
          await state.mirror(result.bot);
          publish();
        }
        return result;
      }),
    );
  }
  type RoutingThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
  async function projectToJoinFor(thread: RoutingThread, atCreation: boolean) {
    if (!atCreation && thread.status !== "pending") return null;
    const projects = await bb.sdk.projects.list();
    const botHome = store.list().some((bot) => bot.homeProjectId === thread.projectId);
    return !botHome &&
      projects.some((project) => project.id === thread.projectId && project.kind === "standard")
      ? thread.projectId
      : null;
  }
  /** The top-level conversation a handoff continues, so the handoff can take its slot. */
  async function conversationRoot(threadId: string) {
    let current = threadId;
    for (let depth = 0; depth < 32; depth++) {
      const parent = (await bb.sdk.threads.get({ threadId: current }).catch(() => null))
        ?.parentThreadId;
      if (!parent) return current;
      current = parent;
    }
    return current;
  }
  function warnRouting(error: unknown) {
    bb.log.warn(`Bot routing failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  async function routeNewThread(
    thread: RoutingThread,
    atCreation: boolean,
    handoffFrom: string | null = null,
  ) {
    // Every GTD user's sends pass through here. With no bindings and no bot
    // that has projects (a fresh install holds only Dr. Bot), nothing can own them.
    if (
      store.bindings().length === 0 &&
      store
        .list()
        .every(
          (bot) => bot.linkedProjectIds.length === 0 && store.ownedProjects(bot.id).length === 0,
        )
    )
      return null;
    const existing = store.owner(thread.id);
    if (existing) return existing;
    // Our creation request carries a durable explicit choice. A fire-and-forget
    // creation event must not let the project default claim it before dispatch.
    if (atCreation && thread.originPluginId === bb.pluginId) return null;
    const inherited =
      thread.parentThreadId || thread.sourceThreadId ? await resolveOwner(thread.id, false) : null;
    if (inherited) {
      const adopted = store.adoptInherited(
        thread.id,
        inherited,
        await projectToJoinFor(thread, atCreation),
      );
      if (adopted.joined) await state.mirror(store.require(adopted.botId));
      if (adopted.changed) publish();
      return adopted.botId;
    }
    // A handoff of a bot conversation continues as that bot, taking the continued
    // conversation's place in the order (so a handoff of the main becomes main).
    // Only brand-new top-level threads qualify; a later mention never reassigns.
    if (
      handoffFrom &&
      handoffFrom !== thread.id &&
      !thread.parentThreadId &&
      (atCreation || thread.status === "pending")
    ) {
      const source = await resolveOwner(handoffFrom, false).catch(() => null);
      if (source) {
        const adopted = store.adoptInherited(
          thread.id,
          source,
          await projectToJoinFor(thread, atCreation),
          false,
          undefined,
          await conversationRoot(handoffFrom),
        );
        if (adopted.joined) await state.mirror(store.require(adopted.botId));
        if (adopted.changed) publish();
        return adopted.botId;
      }
    }
    if (thread.originPluginId === bb.pluginId || (!atCreation && thread.status !== "pending"))
      return null;
    const assigned = store.bindProjectDefault(thread.id, thread.projectId, thread.createdAt);
    if (assigned) publish();
    return assigned;
  }

  type StateResult = z.infer<typeof stateMutationResultSchema>;
  type StateView = Omit<StateResult, "changed">;
  function identityView(bot: BotMetadata): StateView {
    return {
      botId: bot.id,
      target: "identity",
      revision: bot.updatedAt,
      state: { name: bot.name, role: bot.role, soul: bot.soul },
    };
  }
  async function projectView(bot: BotMetadata, currentProjectId?: string): Promise<StateView> {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const botHomes = new Set(store.list().map((entry) => entry.homeProjectId));
    const ownership = (id: string) => {
      const entry = store.projectOwner(id);
      return {
        ownerBotId: entry?.botId ?? null,
        ownerName: entry ? store.require(entry.botId).name : null,
      };
    };
    const available = projects
      .filter((project) => project.kind === "standard" && !botHomes.has(project.id))
      .map((project) =>
        Object.assign({ id: project.id, name: project.name }, ownership(project.id)),
      );
    const current = projects.find((project) => project.id === currentProjectId);
    return {
      botId: bot.id,
      target: "project",
      revision: bot.updatedAt,
      state: {
        ...(currentProjectId
          ? { currentProject: current ? botProjectContext(bot, current, store) : null }
          : {}),
        linked: bot.linkedProjectIds.map((id) => ({
          id,
          name: projects.find((project) => project.id === id)?.name ?? "Unavailable project",
          role: store.projectOwner(id)?.botId === bot.id ? "owner" : "member",
          ...ownership(id),
        })),
        available: available.slice(0, 200),
        availableCount: available.length,
      },
    };
  }
  function documentView(
    bot: BotMetadata,
    target: "memory" | "settings",
    document: { content: string; sha256: string },
  ): StateView {
    return {
      botId: bot.id,
      target,
      revision: bot.updatedAt,
      state:
        target === "memory"
          ? {
              ...document,
              facts: memoryFacts(document.content),
              characters: document.content.length,
              maxCharacters: MEMORY_MAX_CHARS,
            }
          : { sha256: document.sha256, values: JSON.parse(document.content) },
    };
  }
  async function readBotState(
    botId: string,
    input: z.infer<typeof stateReadSchema>,
    currentProjectId?: string,
  ) {
    return serial(botId, async () => {
      if (input.target === "project") return projectView(store.require(botId), currentProjectId);
      const bot = await state.prepare(botId);
      if (input.target === "identity") return identityView(bot);
      return documentView(
        bot,
        input.target,
        await state.read(bot, input.target === "memory" ? "MEMORY.md" : "settings.json"),
      );
    });
  }
  async function applyBotState(botId: string, change: BotStateMutation): Promise<StateResult> {
    if (change.target === "identity") {
      const bot = await serial(botId, () => state.prepare(botId));
      if (bot.updatedAt !== change.expectedRevision)
        throw new Error("Identity changed. Read identity again and merge your update.");
      const fields = {
        name: change.name ?? bot.name,
        role: change.role ?? bot.role,
        soul: change.soul ?? bot.soul,
      };
      if (Object.entries(fields).every(([key, value]) => bot[key as keyof typeof fields] === value))
        return { ...identityView(bot), changed: false };
      const next = await saveBotIdentity({
        ...fields,
        botId,
        avatar: bot.avatar,
        sectionId: bot.sectionId,
        linkedProjectIds: bot.linkedProjectIds,
        expectedUpdatedAt: change.expectedRevision,
        expectedStateHashes: bot.stateHashes,
      });
      return { ...identityView(next), changed: true };
    }
    if (change.target === "project") {
      const result = await updateProjectRole(botId, change.action, change.projectId);
      return { ...(await projectView(result.bot)), changed: result.changed };
    }
    return serial(botId, async () => {
      await state.prepare(botId);
      const file = change.target === "memory" ? "MEMORY.md" : "settings.json";
      if (change.target === "memory" && change.action === "overwrite") {
        // Whole-document replacements must never retry against a newer hash.
        const current = await state.read(store.require(botId), "MEMORY.md");
        validateMemory(change.content);
        if (current.sha256 !== change.expectedSha256)
          throw new BotStateConflictError(
            'Memory changed. Read it again with bot_read_state({"target":"memory"}), condense the latest content, then overwrite using its sha256.',
          );
        if (change.content === current.content)
          return { ...documentView(store.require(botId), "memory", current), changed: false };
        const written = await state.update(
          botId,
          "MEMORY.md",
          change.content,
          change.expectedSha256,
        );
        return { ...documentView(store.require(botId), "memory", written), changed: true };
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const bot = store.require(botId);
        const current = await state.read(bot, file);
        const content = mutateStateDocument(current.content, change);
        if (change.target === "memory") validateMemory(content);
        if (content === current.content)
          return { ...documentView(bot, change.target, current), changed: false };
        try {
          const written = await state.update(botId, file, content, current.sha256);
          return { ...documentView(store.require(botId), change.target, written), changed: true };
        } catch (error) {
          if (!(error instanceof BotStateConflictError) || attempt === 2) throw error;
        }
      }
      throw new Error("State changed too often; read it again and retry");
    });
  }
  /**
   * A projectless request (Personal, or the bot's home) runs in the bot's own
   * home project's checkout, never BB's shared Personal workspace.
   */
  async function withHome(botId: string, request: SpawnRequest): Promise<SpawnRequest> {
    const bot = store.require(botId);
    if (
      request.projectId !== (await personalProjectId()) &&
      request.projectId !== bot.homeProjectId
    )
      return request;
    const projectId = await serial("project-create", () => ensureHomeProject(bb, store, botId));
    publish();
    return {
      ...request,
      projectId,
      environment: {
        type: "host",
        hostId: bot.hostId,
        workspace: { type: "unmanaged", path: null },
      },
    };
  }
  /**
   * Spawns a conversation bound to the bot from its first dispatch. `main`
   * says whether it becomes the bot's main conversation.
   */
  async function startConversation(
    botId: string,
    original: SpawnRequest,
    main: "always" | "if-none" | "never",
  ) {
    const request = await withHome(botId, original);
    if (request.projectId !== store.require(botId).homeProjectId)
      await updateProjectRole(botId, "join", request.projectId);
    return serial(botId, async () => {
      const bot = await state.prepare(botId);
      await validateConversationProject(bot, request.projectId);
      const token = randomUUID();
      const makeMain = main === "always" || (main === "if-none" && !bot.mainThreadId);
      if (makeMain) mainStarts.add(token);
      store.stageStart(token, botId, request.projectId);
      const thread = await bb.sdk.threads
        .spawn({
          ...request,
          input: [
            ...request.input,
            {
              type: "text",
              text: conversationStartText(token, bot.name),
              mentions: [],
              visibility: "agent-only",
            },
          ],
        })
        .finally(() => mainStarts.delete(token));
      store.bind(thread.id, botId);
      store.cancelStart(token);
      if (makeMain) setMainThread(botId, thread.id);
      publish();
      return { threadId: thread.id };
    });
  }
  /**
   * Start tokens of conversations that become the bot's main chat. The first
   * dispatch marks the thread main, so its agent is configured as the main chat.
   */
  const mainStarts = new Set<string>();
  function setMainThread(botId: string, threadId: string) {
    const latest = store.require(botId);
    if (latest.mainThreadId === threadId) return;
    store.save({ ...latest, mainThreadId: threadId, updatedAt: nextTimestamp(latest.updatedAt) });
  }
  /** The bot's preferred harness, as spawn request fields; empty for bb's defaults. */
  const presetExecution = (bot: BotMetadata) => {
    const execution = bot.launchPreset?.execution;
    return execution
      ? {
          providerId: execution.providerId,
          model: execution.model,
          reasoningLevel: execution.reasoningLevel,
          ...(execution.serviceTier ? { serviceTier: execution.serviceTier } : {}),
          ...(execution.permissionMode ? { permissionMode: execution.permissionMode } : {}),
        }
      : {};
  };
  /** Where a new main chat starts: the bot's owned project, else (via Personal) its home. */
  async function mainChatTarget(bot: BotMetadata) {
    const projects = (await bb.sdk.projects.list()).filter(
      (project) => project.kind === "standard",
    );
    const owned = ownedConversationProjectId({
      bot,
      projects,
      owners: store.projectOwners(),
      personalProjectId: await personalProjectId(),
    });
    if (owned)
      return {
        projectId: owned,
        environment:
          bot.launchPreset?.workspace === "worktree"
            ? worktreeLaunchEnvironment(bot.hostId)
            : projectLaunchEnvironment(bot.hostId),
      };
    return {
      projectId: await personalProjectId(),
      environment: {
        type: "host" as const,
        hostId: bot.hostId,
        workspace: { type: "personal" as const },
      },
    };
  }
  /**
   * The bot's main chat: the one conversation its user talks in, and the
   * parent of its routine and work subthreads. Started when the bot has none
   * live; bb refuses a thread without a first message, so a new one opens with
   * the bot greeting the user.
   */
  function ensureMainChat(botId: string) {
    return serial(`main:${botId}`, async () => {
      const bot = store.require(botId);
      if (bot.mainThreadId) {
        const current = await bb.sdk.threads.get({ threadId: bot.mainThreadId }).catch(() => null);
        if (current && current.archivedAt === null && current.deletedAt === null)
          return { threadId: current.id, created: false };
      }
      const { threadId } = await startConversation(
        botId,
        {
          ...(await mainChatTarget(bot)),
          title: bot.name,
          ...presetExecution(bot),
          input: [
            {
              type: "text",
              text: tools.read("bots/main-chat-start", { name: bot.name }),
              mentions: [],
              visibility: "agent-only",
            },
          ],
        },
        "always",
      );
      return { threadId, created: true };
    });
  }
  const startRoutineConversation: StartRoutineConversation = async ({
    bot,
    routine,
    text,
    parentThreadId,
  }) => {
    // A Personal routine runs in the bot's home project; startConversation redirects it.
    const { threadId } = await startConversation(
      bot.id,
      {
        projectId: routine.projectId,
        title: routine.name,
        environment: { type: "project-default" },
        parentThreadId,
        parentNotifications: "auto",
        ...presetExecution(bot),
        input: [{ type: "text", text, mentions: [] }],
      },
      "never",
    );
    return threadId;
  };
  const publishRoutines = () => bb.rpc.experimental_invalidate([BOT_TAGS.routines]);
  const skills = createBotSkills(bb, store, async (botId) => {
    const before = store.require(botId).homeProjectId;
    const projectId = await serial("project-create", () => ensureHomeProject(bb, store, botId));
    if (projectId !== before) publish();
    return projectId;
  });
  const publishSkills = () => bb.rpc.experimental_invalidate([BOT_TAGS.skills]);
  async function routineProjects(bot: BotMetadata) {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const personal = projects.find((project) => project.kind === "personal");
    if (!personal) throw new Error("BB's personal project is unavailable");
    personalId = personal.id;
    return [
      { id: personal.id, name: "Home" },
      ...bot.linkedProjectIds.map((id) => ({
        id,
        name: projects.find((project) => project.id === id)?.name ?? "Unavailable project",
      })),
    ];
  }
  const routines = createRoutines(bb, {
    automations,
    requireBot: (botId) => store.require(botId),
    allowedProjectIds: async (bot) => (await routineProjects(bot)).map((project) => project.id),
    runsIn: async (bot, routineProjectId, threadProjectId) =>
      threadProjectId === routineProjectId ||
      (routineProjectId === (await personalProjectId()) && threadProjectId === bot.homeProjectId),
    resolveOwner,
    mainChatId: async (bot) => (await ensureMainChat(bot.id)).threadId,
    startConversation: startRoutineConversation,
    publish: publishRoutines,
  });
  async function ownedRoutine(botId: string, routineId: string) {
    const routine = routines.require(routineId);
    if (routine.botId !== botId) throw new Error("That routine belongs to another bot.");
    return routine;
  }

  const contextOwner = (ctx: PluginAgentConfigurationContext) => owner(ctx.thread);
  // One source for the agent configuration and the Info tab's prompt preview.
  const botAgentConfiguration = (
    bot: BotMetadata,
    project: PluginAgentConfigurationContext["project"],
    threadId: string,
  ) => ({
    tools: [
      "bot_read_state",
      "bot_update_state",
      "bot_routine_list",
      "bot_routine_update",
      "bot_skill_read",
      "bot_skill_update",
    ],
    skills: [BOTS_SKILL],
    instructions: botInstructions(
      bot,
      botProjectContext(bot, project, store),
      bot.mainThreadId === threadId,
    ),
  });
  bb.agents.configure((ctx) => {
    const botId = contextOwner(ctx);
    const bot = botId ? store.get(botId) : null;
    return bot ? botAgentConfiguration(bot, ctx.project, ctx.thread.id) : { tools: [], skills: [] };
  });
  bb.agents.registerTool({
    name: "bot_read_state",
    ...tools.tool("bot_read_state"),
    parameters: stateReadSchema,
    execute: async (input, ctx) => {
      const botId = await resolveOwner(ctx.threadId);
      if (!botId) throw new Error("This conversation is not assigned to a bot");
      return JSON.stringify(await readBotState(botId, input, ctx.projectId));
    },
  });
  bb.agents.registerTool({
    name: "bot_update_state",
    ...tools.tool("bot_update_state"),
    parameters: stateMutationToolSchema,
    execute: async (change, ctx) => {
      const botId = await resolveOwner(ctx.threadId);
      if (!botId) throw new Error("This conversation is not assigned to a bot");
      return JSON.stringify(
        await applyBotState(botId, stateMutationSchema.parse(normalizeStateMutation(change))),
      );
    },
  });
  bb.agents.registerTool({
    name: "bot_routine_list",
    ...tools.tool("bot_routine_list"),
    parameters: z.object({}).strict(),
    execute: async (_input, ctx) => {
      const botId = await resolveOwner(ctx.threadId);
      if (!botId) throw new Error("This conversation is not assigned to a bot");
      const [views, projects] = await Promise.all([
        routines.listViews(botId),
        routineProjects(store.require(botId)),
      ]);
      return JSON.stringify({ routines: views, projects });
    },
  });
  bb.agents.registerTool({
    name: "bot_routine_update",
    ...tools.tool("bot_routine_update"),
    parameters: routineToolSchema,
    execute: async (input, ctx) => {
      const botId = await resolveOwner(ctx.threadId);
      if (!botId) throw new Error("This conversation is not assigned to a bot");
      const fields = Object.fromEntries(
        (["name", "instruction", "cron", "timezone", "projectId"] as const)
          .filter((key) => input[key] != null)
          .map((key) => [key, input[key]]),
      ) as Partial<RoutineFields>;
      if (input.action === "create") {
        const allowed = (await routineProjects(store.require(botId))).map((project) => project.id);
        const projectId =
          fields.projectId ?? (allowed.includes(ctx.projectId) ? ctx.projectId : allowed[0]!);
        const missing = (["name", "instruction", "cron", "timezone"] as const).filter(
          (key) => !fields[key],
        );
        if (missing.length) throw new Error(`create needs ${missing.join(", ")}`);
        return JSON.stringify(
          await routines.create(botId, { ...(fields as RoutineFields), projectId }, ctx.threadId),
        );
      }
      if (!input.routineId)
        throw new Error(`${input.action} needs routineId from bot_routine_list`);
      await ownedRoutine(botId, input.routineId);
      if (input.action === "update") {
        if (!Object.keys(fields).length)
          throw new Error(
            "update needs at least one of name, instruction, cron, timezone, projectId",
          );
        return JSON.stringify(await routines.update(input.routineId, fields));
      }
      return JSON.stringify(await routines.act(input.routineId, input.action));
    },
  });
  bb.agents.registerTool({
    name: "bot_skill_read",
    ...tools.tool("bot_skill_read"),
    parameters: skillReadToolSchema,
    execute: async ({ name }, ctx) => {
      const botId = await resolveOwner(ctx.threadId);
      if (!botId) throw new Error("This conversation is not assigned to a bot");
      return JSON.stringify(
        name ? await skills.read(botId, name) : { skills: await skills.list(botId) },
      );
    },
  });
  bb.agents.registerTool({
    name: "bot_skill_update",
    ...tools.tool("bot_skill_update"),
    parameters: skillUpdateToolSchema,
    execute: async ({ action, name, content, expectedSha256 }, ctx) => {
      const botId = await resolveOwner(ctx.threadId);
      if (!botId) throw new Error("This conversation is not assigned to a bot");
      if (action === "delete") {
        const result = await skills.remove(botId, name);
        publishSkills();
        return JSON.stringify(result);
      }
      if (!content) throw new Error("write needs content: the complete SKILL.md");
      const result = await skills.save(botId, {
        name,
        content,
        expectedSha256: expectedSha256 ?? null,
      });
      publishSkills();
      return JSON.stringify(result);
    },
  });
  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    for (const block of ctx.input.blocks) {
      if (block.type !== "text" || block.visibility !== "agent-only") continue;
      const token = block.text.match(START_MARKER)?.[1];
      if (!token || ctx.thread.originPluginId !== bb.pluginId) continue;
      const start = store.pendingStartContext(token);
      if (!start) continue;
      if (start.projectId === null)
        await validateConversationProject(store.require(start.botId), ctx.thread.projectId);
      else if (start.projectId !== ctx.thread.projectId)
        throw new Error("Bot conversation start belongs to a different project");
      store.finishStart(token, ctx.thread.id);
      if (mainStarts.has(token)) setMainThread(start.botId, ctx.thread.id);
      publish();
      return { action: "proceed" };
    }
    // Routing is best effort: a failed ancestor read must not block the send.
    await routeNewThread(
      ctx.thread,
      false,
      handoffSourceThreadId(ctx.input.blocks, ctx.thread.originPluginId),
    ).catch(warnRouting);
    return { action: "proceed" };
  });
  bb.events.on("thread.created", async ({ thread }) => {
    await routeNewThread(thread, true, handoffSourceFromText(thread.titleFallback)).catch(
      warnRouting,
    );
  });

  registerBotMentions(bb, store);
  const lastMessages = createLastMessages(bb, store, publish);

  function createBot({
    name,
    role,
    hostId,
    avatar,
    sectionId,
    linkedProjectIds,
    ownedProjectIds,
    soul,
    memory,
    settings,
    launchPreset,
    pinned,
    builtin,
  }: z.infer<typeof rpcContract.bot_create.input> & Pick<BotMetadata, "pinned" | "builtin">) {
    return serial("registry", async () => {
      await validateLinks(linkedProjectIds);
      if (ownedProjectIds) await validateLinks(ownedProjectIds);
      validateSection(sectionId);
      if (!(await bb.sdk.hosts.list()).some((host) => host.id === hostId))
        throw new Error("Choose an enrolled execution machine");
      const id = `bot_${randomUUID().replaceAll("-", "")}`;
      let created: BotMetadata = {
        id,
        name,
        role,
        hostId,
        stateReady: true,
        homeProjectId: null,
        avatar,
        sectionId,
        linkedProjectIds,
        soul,
        agents: "",
        memory: "",
        settings: {},
        stateHashes: { ...EMPTY_HASHES },
        order: store.list().length,
        mainThreadId: null,
        hiddenUntilActivity: false,
        hiddenAt: null,
        updatedAt: Date.now(),
        legacyProjectId: null,
        ...(pinned ? { pinned } : {}),
        ...(builtin ? { builtin } : {}),
      };
      if (memory !== undefined) created = applyState(created, "MEMORY.md", memory);
      if (launchPreset !== undefined) created.launchPreset = launchPreset;
      if (settings !== undefined)
        created = applyState(
          created,
          "settings.json",
          stateContent({ ...created, settings }, "settings.json"),
        );
      store.saveWithProjects(created, ownedProjectIds);
      const ready = await state.prepare(id);
      publish();
      return ready;
    });
  }

  /** The enrolled machine the Default machine setting names, if any. */
  async function configuredHost(hosts: Awaited<ReturnType<typeof bb.sdk.hosts.list>>) {
    return matchDefaultMachine(hosts, (await settings.get()).defaultMachine);
  }

  /**
   * The machine a new bot runs on: the Default machine setting's (when
   * `connectedOnly`, only while it is connected), else the calling bot's, else
   * a connected one, else (unless `connectedOnly`) any enrolled one.
   */
  async function defaultHostId(
    callerThreadId?: string,
    connectedOnly = false,
  ): Promise<string | null> {
    const hosts = await bb.sdk.hosts.list();
    const configured = await configuredHost(hosts);
    if (configured && (!connectedOnly || configured.status === "connected")) return configured.id;
    const callerBot = callerThreadId ? await resolveOwner(callerThreadId, false) : null;
    if (callerBot !== null) return store.require(callerBot).hostId;
    const connected = hosts.find((host) => host.status === "connected");
    return (connected ?? (connectedOnly ? undefined : hosts[0]))?.id ?? null;
  }

  // Every install keeps one bot, Dr. Bot, pinned first. It is how new bots get
  // made: its soul points it at `bb bots create`. Seeded on the first list
  // read that finds a connected machine.
  let seeding: Promise<void> | null = null;
  function ensureDrBot(): Promise<void> {
    if (store.list().some((bot) => bot.builtin === "dr-bot")) return Promise.resolve();
    seeding ??= (async () => {
      // A connected machine only: Dr. Bot keeps the machine it is seeded on.
      const hostId = await defaultHostId(undefined, true);
      if (hostId === null || store.list().some((bot) => bot.builtin === "dr-bot")) return;
      await createBot({
        name: "Dr. Bot",
        role: "Makes new bots",
        hostId,
        avatar: { color: "#f8f8f2", shape: "round", expression: "happy", motion: "calm" },
        sectionId: null,
        linkedProjectIds: [],
        soul: tools.read("bots/dr-bot-soul"),
        pinned: true,
        builtin: "dr-bot",
      });
    })().finally(() => {
      seeding = null;
    });
    return seeding;
  }

  bb.rpc.register(rpcContract, {
    project_browse: ({ hostId, path }) => browseProjectDirectory(bb, { hostId, path }),
    project_create: (input) =>
      serial("project-create", () =>
        serial(`project-create:${input.requestId}`, () => createWorkProject(bb, store, input)),
      ),
    workflow_runs: async () => ({ runs: await workflowRuns.list() }),
    bots_list: async () => {
      const warnings: string[] = [];
      await ensureDrBot().catch((error: unknown) =>
        warnings.push(
          `Dr. Bot could not be created: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      await Promise.all(store.list().map((bot) => serial(bot.id, () => state.prepare(bot.id))));
      const [hosts, projects] = await Promise.all([
        bb.sdk.hosts.list(),
        bb.sdk.projects.list({ includePersonal: true }),
      ]);
      const personal = projects.find((project) => project.kind === "personal");
      if (!personal) throw new Error("BB's personal project is unavailable");
      personalId = personal.id;
      const { defaultMachine } = await settings.get();
      const configured = matchDefaultMachine(hosts, defaultMachine);
      if (!configured && typeof defaultMachine === "string" && defaultMachine.trim())
        warnings.push(
          `Default machine "${defaultMachine.trim()}" matches no enrolled machine, so new bots use the first connected one.`,
        );
      const bots = store.list();
      const botHomes = new Set(bots.map((bot) => bot.homeProjectId));
      return {
        bots,
        projectOwners: store.projectOwners().map(({ projectId, botId }) => ({ projectId, botId })),
        warnings: [...warnings, ...state.warnings()],
        personalProjectId: personalId,
        threadBindings: store.bindings(),
        detachedThreadIds: store.detachedIds(),
        lastMessages: lastMessages.list(bots),
        completions: completion.completions(),
        sections: store.sections(),
        defaultHostId: configured?.id ?? null,
        hosts: hosts.map((host) => ({
          id: host.id,
          name: host.name,
          connected: host.status === "connected",
        })),
        projects: projects
          .filter((project) => project.kind === "standard" && !botHomes.has(project.id))
          .map((project) => ({ id: project.id, name: project.name })),
      };
    },
    bot_create: (input) => createBot(input),
    bot_prepare: ({ botId }) => serial(botId, () => state.prepare(botId)),
    bot_update: saveBotIdentity,
    bots_reorder: ({ bots: placements }) =>
      serial("registry", async () => {
        const bots = store.list();
        if (
          placements.length !== bots.length ||
          new Set(placements.map((entry) => entry.botId)).size !== bots.length
        )
          throw new Error("Reordering must include every bot exactly once");
        store.saveAll(
          placements.map(({ botId, sectionId }, order) => {
            validateSection(sectionId);
            const bot = store.require(botId);
            return { ...bot, sectionId, order, updatedAt: nextTimestamp(bot.updatedAt) };
          }),
        );
        publish();
        return { ok: true } as const;
      }),
    section_create: ({ name }) =>
      serial("registry", async () => {
        const saved = store.sections();
        const section = { id: randomUUID(), name, order: saved.length };
        store.saveSections([...saved, section]);
        publish();
        return section;
      }),
    section_update: ({ sectionId, name }) =>
      serial("registry", async () => {
        const saved = store.sections();
        const section = saved.find((section) => section.id === sectionId);
        if (!section) throw new Error("Section no longer exists");
        const next = { ...section, name };
        store.saveSections(saved.map((entry) => (entry.id === sectionId ? next : entry)));
        publish();
        return next;
      }),
    section_delete: ({ sectionId }) =>
      serial("registry", async () => {
        validateSection(sectionId);
        store.saveAll(
          store
            .list()
            .filter((bot) => bot.sectionId === sectionId)
            .map((bot) =>
              Object.assign(bot, { sectionId: null, updatedAt: nextTimestamp(bot.updatedAt) }),
            ),
        );
        store.saveSections(store.sections().filter((section) => section.id !== sectionId));
        publish();
        return { ok: true } as const;
      }),
    visibility_set: ({ botId, hiddenUntilActivity }) =>
      serial(botId, async () => {
        const bot = store.require(botId);
        const next = store.save({
          ...bot,
          hiddenUntilActivity,
          hiddenAt: hiddenUntilActivity ? Date.now() : null,
          updatedAt: nextTimestamp(bot.updatedAt),
        });
        publish();
        return next;
      }),
    pin_set: ({ botId, pinned }) =>
      serial(botId, async () => {
        const bot = store.require(botId);
        const next = store.save({ ...bot, pinned, updatedAt: nextTimestamp(bot.updatedAt) });
        publish();
        return next;
      }),
    main_set: ({ botId, threadId }) =>
      serial(botId, async () => {
        if ((await resolveOwner(threadId)) !== botId)
          throw new Error("Conversation does not belong to this bot");
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.archivedAt !== null)
          throw new Error("Restore this conversation before making it main");
        const latest = store.require(botId);
        const next = store.save({
          ...latest,
          mainThreadId: threadId,
          updatedAt: nextTimestamp(latest.updatedAt),
        });
        publish();
        return next;
      }),
    main_open: ({ botId }) => ensureMainChat(botId),
    conversation_create: ({ botId, request, makeMain }) =>
      startConversation(botId, request, makeMain ? "always" : "if-none"),
    conversation_fork: async ({ botId, sourceThreadId, request }) =>
      serial(botId, async () => {
        const bot = await state.prepare(botId);
        const source = await bb.sdk.threads.get({ threadId: sourceThreadId });
        if (source.archivedAt !== null || source.deletedAt !== null)
          throw new Error("The source conversation is archived or deleted.");
        if ((await resolveOwner(sourceThreadId, false)) !== botId)
          throw new Error("The source conversation does not belong to this bot.");
        if (request.environment.type !== "reuse" || !source.environmentId)
          throw new Error("Forks must reuse the source conversation’s environment.");
        if (request.environment.environmentId !== source.environmentId)
          throw new Error("The fork environment must match the source conversation.");
        if (request.projectId !== source.projectId)
          throw new Error("Forks must stay in the source project.");
        const thread = await bb.sdk.threads.fork({
          sourceThreadId,
          environment: request.environment,
          input: request.input,
          permissionMode: request.permissionMode,
        });
        store.bind(thread.id, bot.id);
        publish();
        return { threadId: thread.id };
      }),
    conversation_reorder: ({ botId, threadId, targetThreadId, position }) =>
      serial(botId, async () => {
        const { rows } = await listBotConversations(bb, store.require(botId), resolveOwner);
        const source = rows.find((row) => row.id === threadId);
        const target = rows.find((row) => row.id === targetThreadId);
        if (!source || !target)
          throw new Error(
            "Both conversations must be visible and belong to this bot. Refresh and try again.",
          );
        const ids = new Set(rows.map((row) => row.id));
        const parent = (row: typeof source) =>
          row.parentThreadId && ids.has(row.parentThreadId) ? row.parentThreadId : null;
        if (parent(source) !== parent(target))
          throw new Error("Reorder conversations within the same branch.");
        if (threadId !== targetThreadId) {
          const order = rows.map((row) => row.id).filter((id) => id !== threadId);
          order.splice(order.indexOf(targetThreadId) + Number(position === "after"), 0, threadId);
          store.mutate(botId, (bot) => ({
            ...bot,
            threadOrder: order,
            updatedAt: nextTimestamp(bot.updatedAt),
          }));
          publish();
        }
        return { ok: true } as const;
      }),
    conversation_complete: async ({ threadId, completed }) => {
      if (!(await resolveOwner(threadId, false)))
        throw new Error("Only bot conversations can be completed.");
      return completion.setCompleted(threadId, completed);
    },
    conversation_nest: ({ threadId, parentThreadId }) =>
      serial("registry", async () => {
        if (threadId === parentThreadId)
          throw new Error("A conversation cannot be nested under itself.");
        const thread = await bb.sdk.threads.get({ threadId });
        const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
        if (
          thread.archivedAt !== null ||
          thread.deletedAt !== null ||
          parent.archivedAt !== null ||
          parent.deletedAt !== null
        )
          throw new Error("Archived conversations cannot be nested.");
        const seen = new Set<string>([threadId]);
        let current: string | null = parent.parentThreadId;
        while (current) {
          if (seen.has(current)) throw new Error("That nesting would create a cycle.");
          seen.add(current);
          const ancestor = await bb.sdk.threads.get({ threadId: current });
          current = ancestor.parentThreadId;
        }
        await bb.sdk.threads.update({ threadId, parentThreadId });
        publish();
        return { ok: true } as const;
      }),
    thread_bot: async ({ threadId }) => {
      const botId = await resolveOwner(threadId, false);
      return {
        botId,
        explicit: Boolean(botId) && store.owner(threadId) === botId,
        detached: store.detached(threadId),
        bots: store.list().map((bot) => ({
          id: bot.id,
          name: bot.name,
          role: bot.role,
          avatar: bot.avatar,
          hidden: bot.hiddenUntilActivity,
        })),
      };
    },
    thread_bot_prompt: async ({ threadId }) => {
      const botId = await resolveOwner(threadId, false);
      const bot = botId ? store.get(botId) : undefined;
      if (!bot) return { botId: null, tools: [], skills: [], sections: [] };
      const thread = await bb.sdk.threads.get({ threadId });
      const project = (await bb.sdk.projects.list({ includePersonal: true })).find(
        (entry) => entry.id === thread.projectId,
      );
      if (!project) throw new Error("This conversation's project is unavailable.");
      const config = botAgentConfiguration(bot, project, threadId);
      return {
        botId: bot.id,
        tools: config.tools,
        skills: config.skills,
        sections: [
          { id: "bot" as const, title: "Bot context", text: config.instructions },
          { id: "tools" as const, title: "Tool guidance", text: botGuidance() },
        ],
      };
    },
    // The user's explicit choice in the thread header or Info tab. Unlike drag/dialog
    // assignment it may move a conversation between bots or detach it ("No bot"); the
    // conversation's descendants in the old bot move with it.
    conversation_set_bot: ({ threadId, botId }) =>
      serial("registry", async () => {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.archivedAt || thread.deletedAt)
          throw new Error("Restore this conversation before changing its bot.");
        const from = await resolveOwner(threadId, false);
        if (from === botId) return { ok: true as const, threadIds: [] };
        const run = async () => {
          const target = botId ? store.require(botId) : null;
          let projectToJoin: string | null = null;
          if (
            target &&
            thread.projectId !== (await personalProjectId()) &&
            thread.projectId !== target.homeProjectId &&
            !target.linkedProjectIds.includes(thread.projectId)
          ) {
            await validateLinks([thread.projectId]);
            projectToJoin = thread.projectId;
          }
          const descendants: string[] = [];
          if (from) {
            const rows = (await listBotConversations(bb, store.require(from), resolveOwner)).rows;
            const inSubtree = new Set([threadId]);
            for (let grew = true; grew;) {
              grew = false;
              for (const row of rows)
                if (
                  row.parentThreadId &&
                  inSubtree.has(row.parentThreadId) &&
                  !inSubtree.has(row.id)
                ) {
                  inSubtree.add(row.id);
                  descendants.push(row.id);
                  grew = true;
                }
            }
          }
          const result = store.reassign(threadId, descendants, botId, projectToJoin);
          if (result.joined && target) await state.mirror(store.require(target.id));
          publish();
          return { ok: true as const, threadIds: [threadId, ...descendants] };
        };
        return from
          ? serial(from, () => (botId ? serial(botId, run) : run()))
          : botId
            ? serial(botId, run)
            : run();
      }),
    conversation_assign: ({ botId, threadId, placeFirst }) =>
      serial("registry", () =>
        serial(botId, async () => {
          const bot = store.require(botId);
          const thread = await bb.sdk.threads.get({ threadId });
          if (thread.archivedAt || thread.deletedAt)
            throw new Error("Restore this conversation before assigning it.");
          const existing = await resolveOwner(threadId, false);
          if (existing && existing !== botId)
            throw new Error("Conversation already belongs to another bot");
          if (store.owner(threadId) === botId) return { ok: true } as const;
          const needsLink =
            thread.projectId !== (await personalProjectId()) &&
            thread.projectId !== bot.homeProjectId &&
            !bot.linkedProjectIds.includes(thread.projectId);
          if (needsLink) await validateLinks([thread.projectId]);
          // Membership and the new association commit together; a competing binding
          // must win without leaving an unwanted membership behind.
          // Explicit false is an outside drop at the end; omitted preserves dialog ordering.
          const appendAfter =
            placeFirst === false
              ? (await listBotConversations(bb, store.require(botId), resolveOwner)).rows.map(
                  (row) => row.id,
                )
              : undefined;
          const assigned = store.adoptInherited(
            threadId,
            botId,
            needsLink ? thread.projectId : null,
            placeFirst,
            appendAfter,
          );
          if (assigned.botId !== botId)
            throw new Error("Conversation already belongs to another bot");
          if (assigned.joined) await state.mirror(store.require(botId));
          if (assigned.changed) publish();
          return { ok: true } as const;
        }),
      ),
    state_read: ({ botId, file }) => serial(botId, () => state.read(store.require(botId), file)),
    state_update: ({ botId, file, content, expectedSha256 }) =>
      serial(botId, async () => {
        await state.prepare(botId);
        return state.update(botId, file, content, expectedSha256);
      }),
    state_apply: ({ botId, change }) => applyBotState(botId, change),
    routines_list: async ({ botId }) => {
      const bot = store.require(botId);
      const [views, projects] = await Promise.all([
        routines.listViews(botId),
        routineProjects(bot),
      ]);
      return { routines: views, projects };
    },
    routine_save: async ({ botId, routineId, ...fields }) => {
      if (!routineId) return routines.create(botId, fields, null);
      await ownedRoutine(botId, routineId);
      return routines.update(routineId, fields);
    },
    routine_action: ({ routineId, action }) => routines.act(routineId, action),
    routine_runs: async ({ routineId, limit }) => ({ runs: await routines.runs(routineId, limit) }),
    skills_list: async ({ botId }) => ({ skills: await skills.list(botId) }),
    skill_read: ({ botId, name }) => skills.read(botId, name),
    skill_save: async ({ botId, ...input }) => {
      const result = await skills.save(botId, input);
      publishSkills();
      return result;
    },
    skill_delete: async ({ botId, name }) => {
      const result = await skills.remove(botId, name);
      publishSkills();
      return result;
    },
  });

  return {
    ...botsCliCommands(bb, store, resolveOwner, completion.records, { createBot, defaultHostId }),
    ...routineCliCommands(store, routines),
  };
}
