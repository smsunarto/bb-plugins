import {
  cliCommand,
  PluginCliError,
  type BbPluginApi,
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import type { BotMetadata } from "../contract.ts";
import type { BotStore } from "./bot-store.ts";
import { listBotConversations } from "./bot-conversations.ts";
import type { CompletionRecord } from "./completion.ts";
import { mainConversationId, toCompletionThread } from "./completion-server.ts";

const files = instructionFiles(import.meta.url);

const MESSAGE_MAX_CHARS = 12000;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// oxlint-disable-next-line no-control-regex -- strips terminal control characters from names
const printable = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

function recipient(bots: BotMetadata[], selector: string) {
  const byId = bots.find((bot) => bot.id === selector);
  if (byId) return byId;
  const matches = bots.filter((bot) => bot.name === selector);
  if (matches.length > 1)
    throw new Error(
      "Several bots have that name. Use an exact bot ID from bb gtd-sidebar bots list.",
    );
  if (!matches.length)
    throw new Error("Bot not found. Use bb gtd-sidebar bots list for IDs and exact names.");
  return matches[0]!;
}

type Sender = { threadId: string; bot: BotMetadata | null } | null;
export function frameBotMessage(sender: Sender, message: string): string {
  if (!sender) return files.read("bots/message/from-cli", { message });
  if (!sender.bot)
    return files.read("bots/message/from-agent", {
      message,
      threadId: JSON.stringify(sender.threadId),
      replyThread: shellQuote(sender.threadId),
    });
  return files.read("bots/message/from-bot", {
    message,
    senderLabel: printable(sender.bot.name).replace(
      /[\\`*_{}[\]()<>#+.!|~-]/g,
      (character) => `\\${character}`,
    ),
    botName: JSON.stringify(sender.bot.name),
    botId: JSON.stringify(sender.bot.id),
    threadId: JSON.stringify(sender.threadId),
    replyBot: shellQuote(sender.bot.id),
    replyThread: shellQuote(sender.threadId),
  });
}

const JSON_OPTION = { type: "boolean", description: "Emit machine-readable JSON" } as const;

const fail = (error: unknown): never => {
  if (error instanceof PluginCliError) throw error;
  throw new PluginCliError(error instanceof Error ? error.message : String(error), {
    code: "bots_failed",
  });
};

/**
 * `bb gtd-sidebar bots list|message`. The default recipient is the shelf's
 * first conversation that is not completed.
 */
export function botsCliCommands(
  bb: BbPluginApi,
  store: BotStore,
  resolveOwner: (threadId: string, persist?: boolean) => Promise<string | null>,
  completionRecords: () => ReadonlyMap<string, CompletionRecord> = () => new Map(),
) {
  const list = cliCommand({
    summary:
      "List bot IDs, activity, visibility, and owned/joined project names without private state",
    options: {
      json: JSON_OPTION,
      limit: { type: "integer", min: 1, max: 100, default: 50, description: "Bots per page" },
      offset: {
        type: "integer",
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        default: 0,
        description: "Bots to skip",
      },
    },
    async run({ options }, ctx) {
      try {
        const all = store.list();
        const { activity, firstThreads } = await listActivity(ctx);
        const projects = new Map(
          (await bb.sdk.projects.list()).map((project) => [project.id, project.name]),
        );
        const bots = all.slice(options.offset, options.offset + options.limit).map((bot) => {
          const owned = new Set(store.ownedProjects(bot.id));
          const project = (id: string) => ({ id, name: projects.get(id) ?? "Unavailable project" });
          return {
            id: bot.id,
            name: bot.name,
            role: bot.role,
            mainThreadId: firstThreads.get(bot.id) ?? null,
            linkedProjectCount: bot.linkedProjectIds.length,
            ownedProjectCount: store.ownedProjects(bot.id).length,
            hidden: bot.hiddenUntilActivity,
            visibility: bot.hiddenUntilActivity ? "hidden" : "visible",
            status: activity.get(bot.id) ?? "idle",
            ownedProjects: [...owned].map(project),
            joinedProjects: bot.linkedProjectIds.filter((id) => !owned.has(id)).map(project),
          };
        });
        const nextOffset =
          options.offset + bots.length < all.length ? options.offset + bots.length : null;
        const value = { bots, total: all.length, nextOffset };
        return {
          exitCode: 0,
          stdout: options.json
            ? JSON.stringify(value)
            : [
                "BOT ID (MESSAGE TARGET)\tNAME\tSTATUS\tVISIBILITY\tOWNED PROJECTS\tJOINED PROJECTS\tROLE\tFIRST CONVERSATION",
                ...bots.map((bot) =>
                  [
                    bot.id,
                    printable(bot.name),
                    bot.status,
                    bot.visibility,
                    bot.ownedProjects.map((p) => printable(p.name)).join(", ") || "—",
                    bot.joinedProjects.map((p) => printable(p.name)).join(", ") || "—",
                    printable(bot.role),
                    bot.mainThreadId ?? "No conversations",
                  ].join("\t"),
                ),
                ...(nextOffset !== null
                  ? [
                      `More bots: bb gtd-sidebar bots list --offset ${nextOffset} --limit ${options.limit}`,
                    ]
                  : []),
                `${bots.length} shown; ${all.length} total.`,
                'Message: bb gtd-sidebar bots message <bot-id> "Your message"',
              ].join("\n"),
        };
      } catch (error) {
        return fail(error);
      }
    },
  });
  const message = cliCommand({
    summary:
      "Message a bot's first conversation, or reply to one of its conversations; queues while busy",
    description:
      "Sender identity comes from the invoking BB thread; there is no --from override. Quote names and messages containing spaces. List output contains public bot metadata, never private state.",
    positionals: [
      { name: "bot", description: "Bot ID or exact name", required: true },
      { name: "message", description: "Message text", required: true },
    ],
    options: {
      json: JSON_OPTION,
      thread: { type: "string", description: "A conversation belonging to that bot, for replies" },
    },
    async run({ positionals, options }, ctx) {
      try {
        const text = positionals.message.trim();
        if (!text || text.length > MESSAGE_MAX_CHARS)
          throw new Error(`Message must contain 1-${MESSAGE_MAX_CHARS} characters`);
        const bot = recipient(store.list(), positionals.bot);
        const threadId =
          options.thread ??
          mainConversationId(
            (await listBotConversations(bb, bot, resolveOwner)).rows.map(toCompletionThread),
            bot.threadOrder,
            completionRecords(),
          ) ??
          undefined;
        if (!threadId)
          throw new Error(
            "This bot has no visible conversation. Open one from the Bots shelf first, or choose a bound conversation with --thread.",
          );
        if (ctx.threadId === threadId)
          throw new Error(
            "Cannot message the current conversation. Choose another bot or conversation.",
          );
        ctx.signal?.throwIfAborted();
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.archivedAt || thread.deletedAt)
          throw new Error(
            "The target conversation is archived or deleted. Choose an active conversation with --thread.",
          );
        if ((await resolveOwner(threadId, false)) !== bot.id)
          throw new Error(
            "The target conversation does not belong to this bot. Choose a bound conversation.",
          );
        const sender = await resolveSender(ctx);
        ctx.signal?.throwIfAborted();
        const result = await bb.sdk.threads.send({
          threadId,
          mode: "queue-if-active",
          ...(sender ? { senderThreadId: sender.threadId } : {}),
          input: [{ type: "text", text: frameBotMessage(sender, text), mentions: [] }],
        });
        const receipt = {
          botId: bot.id,
          threadId,
          delivery: result.delivery,
          ...(result.delivery === "queued"
            ? {
                queuedMessageId: result.queuedMessage.id,
                waitingOn: result.queuedMessage.waitingOn,
              }
            : {}),
        };
        return {
          exitCode: 0,
          stdout: options.json
            ? JSON.stringify(receipt)
            : `${result.delivery === "queued" ? "Queued for" : "Sent to"} ${printable(bot.name)} (${bot.id}), conversation ${threadId}. This confirms delivery acceptance, not a reply.`,
        };
      } catch (error) {
        return fail(error);
      }
    },
  });
  async function listActivity(ctx: PluginCliContext) {
    type Status = "idle" | "working" | "waiting" | "error";
    const rank = { idle: 0, error: 1, working: 2, waiting: 3 };
    const result = new Map<string, Status>();
    const threads: Awaited<ReturnType<typeof bb.sdk.threads.list>> = [];
    for (let offset = 0; ; offset += 100) {
      ctx.signal?.throwIfAborted();
      const page = await bb.sdk.threads.list({
        archived: false,
        includeHidden: true,
        offset,
        limit: 100,
        signal: ctx.signal,
      });
      threads.push(...page);
      if (page.length < 100) break;
    }
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const direct = new Map(store.bindings().map((binding) => [binding.threadId, binding.botId]));
    const botRows = new Map<string, typeof threads>();
    for (const thread of threads) {
      if (thread.archivedAt || thread.deletedAt) continue;
      let id: string | null = thread.id;
      let owner: string | undefined;
      const visited = new Set<string>();
      while (id && !visited.has(id)) {
        visited.add(id);
        owner = direct.get(id);
        if (owner) break;
        const ancestor = byId.get(id);
        if (!ancestor) {
          owner = (await resolveOwner(id, false)) ?? undefined;
          break;
        }
        id = ancestor.parentThreadId ?? ancestor.sourceThreadId;
      }
      if (!owner) continue;
      if (thread.visibility !== "hidden") {
        const rows = botRows.get(owner) ?? [];
        rows.push(thread);
        botRows.set(owner, rows);
      }
      const runtime = thread.runtime.displayStatus;
      const status: Status =
        thread.hasPendingInteraction || runtime === "waiting-for-host"
          ? "waiting"
          : ["active", "pending", "provisioning", "starting", "stopping"].includes(runtime) ||
              Object.values(thread.activity ?? {}).some((count) => count > 0)
            ? "working"
            : runtime === "error" || thread.queuedWork === "failed"
              ? "error"
              : "idle";
      if (rank[status] > rank[result.get(owner) ?? "idle"]) result.set(owner, status);
    }
    const records = completionRecords();
    const firstThreads = new Map(
      store
        .list()
        .map((bot) => [
          bot.id,
          mainConversationId(
            (botRows.get(bot.id) ?? []).map(toCompletionThread),
            bot.threadOrder,
            records,
          ) ?? undefined,
        ]),
    );
    return { activity: result, firstThreads };
  }
  async function resolveSender(ctx: PluginCliContext): Promise<Sender> {
    if (!ctx.threadId) return null;
    // Verify the invoking conversation exists; never accept a caller-supplied bot name.
    await bb.sdk.threads.get({ threadId: ctx.threadId });
    const id = await resolveOwner(ctx.threadId, false);
    return { threadId: ctx.threadId, bot: id ? store.require(id) : null };
  }
  return { "bots list": list, "bots message": message };
}
