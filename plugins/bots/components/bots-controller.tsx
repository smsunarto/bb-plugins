import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useBbNavigate, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { useBotsRpc } from "../lib/rpc";
import type { BotMetadata } from "../contract";
import type { BotsModel } from "../hooks/use-bots";
import { conversationRoots, orderConversations } from "../lib/conversation-order";
import {
  conversationLaunchProjectId,
  ownedConversationProjectId,
  projectLaunchEnvironment,
  worktreeLaunchEnvironment,
  worktreeLaunchHostId,
} from "../lib/worktree-launch";
import { BotEditor, type EditorTab, type EditorTarget, type ProjectOption } from "./bot-editor";
import { ConversationDialog, type ConversationTarget } from "./conversation-dialog";
import type { ProjectCreationActions } from "./project-create-form";
import { TooltipProvider } from "./ui/tooltip";

/** What the Bots shelf and the bot thread actions can ask for. */
export interface BotsActions {
  createBot(): void;
  editBot(bot: BotMetadata, tab?: EditorTab): void;
  /** Go to the bot's main chat, starting it in the bot's owned project or without one. */
  openMainChat(bot: BotMetadata): void;
  newInProject(bot: BotMetadata, kind: "project" | "worktree", from?: PluginSidebarThread): void;
  fork(bot: BotMetadata, source: PluginSidebarThread): void;
  setHidden(bot: BotMetadata, hidden: boolean): void;
  /** Pin a bot as a card at the top of the Bots tab, or unpin it back to its shelf. */
  setPinned(bot: BotMetadata, pinned: boolean): void;
  setCompleted(threadId: string, completed: boolean): void;
  /**
   * Move a bot past its neighbour in `group`, the bots shown beside it (a
   * pinned grid or one shelf); without a group, past its neighbour in the
   * saved order. Every other bot keeps its place.
   */
  move(bot: BotMetadata, direction: "up" | "down", group?: readonly BotMetadata[]): void;
  hasWorkProjects(bot: BotMetadata): boolean;
}

/**
 * The thread actions run outside the sidebar's React tree, so the mounted
 * controller publishes its actions here. Null while no Bots shelf is mounted.
 */
let publishedActions: BotsActions | null = null;
export const botsActionsBridge = () => publishedActions;

function isPersonalOrHome(projectId: string, bot: BotMetadata, personalProjectId: string | null) {
  return projectId === personalProjectId || projectId === bot.homeProjectId;
}

function availableWorkProjects(
  projects: readonly ProjectOption[],
  bot: BotMetadata,
  personalProjectId: string | null,
) {
  const linked = new Set(bot.linkedProjectIds);
  const work = projects.filter((project) => !isPersonalOrHome(project.id, bot, personalProjectId));
  return [
    ...work.filter((project) => linked.has(project.id)),
    ...work.filter((project) => !linked.has(project.id)),
  ];
}

function allowsConversationProject(
  projectId: string,
  bot: BotMetadata,
  personalProjectId: string | null,
  projects: readonly ProjectOption[],
) {
  if (projectId === personalProjectId) return true;
  if (isPersonalOrHome(projectId, bot, personalProjectId)) return false;
  return (
    bot.linkedProjectIds.includes(projectId) || projects.some((project) => project.id === projectId)
  );
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * The writes behind the shelf's and thread menus' bot actions, and the
 * dialogs they open (editor, new conversation). Used once, by the inbox,
 * which renders `dialogs`.
 */
export function useBotsController(
  model: BotsModel,
  onNavigate: () => void,
): { actions: BotsActions; dialogs: ReactNode } {
  const rpc = useBotsRpc();
  const navigate = useBbNavigate();
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [conversation, setConversation] = useState<ConversationTarget | null>(null);
  const preparing = useRef(false);
  const latest = useRef(model);
  latest.current = model;

  const run = (action: () => Promise<unknown>) => {
    void action().catch((cause: unknown) => toast.error(message(cause)));
  };

  // A hidden bot comes back to the shelf once one of its conversations moves.
  const wakeups = useRef(new Set<string>());
  const wokenKey = model.wokenBotIds.join(" ");
  useEffect(() => {
    for (const botId of model.wokenBotIds) {
      if (wakeups.current.has(botId)) continue;
      wakeups.current.add(botId);
      rpc.call("visibility_set", { botId, hiddenUntilActivity: false }).catch(() => {
        wakeups.current.delete(botId);
      });
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed on the woken ids
  }, [wokenKey, rpc]);

  const actions = useMemo<BotsActions>(() => {
    /** The bot's first root conversation that is not completed, in its saved order. */
    const firstConversation = (bot: BotMetadata) => {
      const threads = (latest.current.threadsByBot.get(bot.id) ?? []).filter(
        (thread) => !latest.current.isCompleted(thread.id),
      );
      return orderConversations(conversationRoots(threads), bot.threadOrder)[0];
    };
    const workProjects = (bot: BotMetadata) =>
      availableWorkProjects(
        latest.current.list?.projects ?? [],
        bot,
        latest.current.list?.personalProjectId ?? null,
      );

    const editBot = async (bot: BotMetadata, tab: EditorTab = "setup") => {
      // Fresh private state and hashes before opening the explicit-save editor;
      // roles live outside the metadata, so read them from the same snapshot.
      const prepared = await rpc.call("bot_prepare", { botId: bot.id });
      if (!prepared.stateReady) throw new Error("Prepare the bot’s private state before editing.");
      const snapshot = await rpc.call("bots_list", {});
      const current = snapshot.bots.find((entry) => entry.id === bot.id);
      if (!current) throw new Error("Bot no longer exists.");
      setEditor({
        kind: "edit",
        metadata: current.updatedAt >= prepared.updatedAt ? current : prepared,
        projectOwners: snapshot.projectOwners ?? [],
        tab,
      });
    };

    const openMainChat = async (bot: BotMetadata) => {
      if (preparing.current) return;
      preparing.current = true;
      try {
        let prepared = await rpc.call("bot_prepare", { botId: bot.id });
        const snapshot = await rpc.call("bots_list", {});
        const current = snapshot.bots.find((entry) => entry.id === bot.id);
        if (!current) throw new Error("Bot no longer exists.");
        if (current.updatedAt >= prepared.updatedAt) prepared = current;
        if (!prepared.stateReady)
          throw new Error("The bot’s private state could not be prepared. Try again.");
        // A missing main chat starts in the bot’s owned project, else (via Personal) in its home project.
        const ownedProjectId = ownedConversationProjectId({
          bot: prepared,
          projects: snapshot.projects,
          owners: snapshot.projectOwners ?? [],
          personalProjectId: snapshot.personalProjectId,
          main: firstConversation(prepared),
        });
        const target = ownedProjectId
          ? {
              projectId: ownedProjectId,
              environment:
                prepared.launchPreset?.workspace === "worktree"
                  ? worktreeLaunchEnvironment(prepared.hostId)
                  : projectLaunchEnvironment(prepared.hostId),
            }
          : {
              projectId: snapshot.personalProjectId,
              environment: {
                type: "host" as const,
                hostId: prepared.hostId,
                workspace: { type: "personal" as const },
              },
            };
        const { threadId } = await rpc.call("main_open", { botId: prepared.id, ...target });
        navigate.toThread(threadId);
        onNavigate();
      } finally {
        preparing.current = false;
      }
    };

    return {
      createBot: () => setEditor({ kind: "create" }),
      editBot: (bot, tab) => run(() => editBot(bot, tab)),
      openMainChat: (bot) => run(() => openMainChat(bot)),
      newInProject: (bot, kind, from) => {
        const main = firstConversation(bot);
        const preferredMain =
          main && bot.linkedProjectIds.includes(main.projectId) ? main : undefined;
        const projectId = conversationLaunchProjectId(workProjects(bot), from, preferredMain);
        if (!projectId) {
          toast.error(
            "Choose a work project for this conversation. Manage this bot’s projects in Edit bot.",
          );
          run(() => editBot(bot, "projects"));
          return;
        }
        const hostId = worktreeLaunchHostId(bot, from, main);
        const environment =
          kind === "project" ? projectLaunchEnvironment(hostId) : worktreeLaunchEnvironment(hostId);
        setConversation({ bot, kind, projectId, environment, makeMain: false });
      },
      fork: (bot, source) => {
        const environmentId = source.environment?.id;
        if (!environmentId) {
          toast.error("This conversation has no reusable environment.");
          return;
        }
        setConversation({
          bot,
          kind: "fork",
          projectId: source.projectId,
          environment: { type: "reuse", environmentId },
          makeMain: false,
          sourceThreadId: source.id,
        });
      },
      setHidden: (bot, hidden) =>
        run(() => rpc.call("visibility_set", { botId: bot.id, hiddenUntilActivity: hidden })),
      setPinned: (bot, pinned) => run(() => rpc.call("pin_set", { botId: bot.id, pinned })),
      setCompleted: (threadId, completed) =>
        run(async () => {
          await rpc.call("conversation_complete", { threadId, completed });
          if (completed) {
            toast.success("Conversation completed", {
              action: {
                label: "Undo",
                onClick: () =>
                  run(() => rpc.call("conversation_complete", { threadId, completed: false })),
              },
            });
          }
        }),
      move: (bot, direction, group) =>
        run(async () => {
          const order = [...latest.current.bots];
          const peers = group ?? order;
          const at = peers.findIndex((entry) => entry.id === bot.id);
          const neighbour = peers[direction === "up" ? at - 1 : at + 1];
          const from = order.findIndex((entry) => entry.id === bot.id);
          const to = neighbour ? order.findIndex((entry) => entry.id === neighbour.id) : -1;
          if (at < 0 || from < 0 || to < 0) return;
          [order[from], order[to]] = [order[to]!, order[from]!];
          await rpc.call("bots_reorder", {
            bots: order.map((entry) => ({ botId: entry.id, sectionId: entry.sectionId })),
          });
        }),
      hasWorkProjects: (bot) => workProjects(bot).length > 0,
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reads the model through `latest`
  }, [rpc]);

  useEffect(() => {
    publishedActions = actions;
    return () => {
      if (publishedActions === actions) publishedActions = null;
    };
  }, [actions]);

  const list = model.list;
  const projectActions: ProjectCreationActions = {
    onCreateProject: (input) => rpc.call("project_create", input),
    onBrowseProjects: (input) => rpc.call("project_browse", input),
  };

  const dialogs = (
    <TooltipProvider>
      {conversation ? (
        <ConversationDialog
          target={conversation}
          onClose={() => setConversation(null)}
          onCreate={async (request) => {
            const bot = latest.current.bots.find((entry) => entry.id === conversation.bot.id);
            if (!bot) throw new Error("This bot is no longer available.");
            if (
              !allowsConversationProject(
                request.projectId,
                bot,
                list?.personalProjectId ?? null,
                list?.projects ?? [],
              )
            ) {
              throw new Error("Choose no project or an available work project.");
            }
            const { threadId } =
              conversation.kind === "fork"
                ? await rpc.call("conversation_fork", {
                    botId: bot.id,
                    sourceThreadId: conversation.sourceThreadId!,
                    request,
                  })
                : await rpc.call("conversation_create", {
                    botId: bot.id,
                    request,
                    makeMain: conversation.makeMain,
                  });
            setConversation(null);
            navigate.toThread(threadId);
            onNavigate();
          }}
        />
      ) : null}
      {editor && list ? (
        <BotEditor
          {...projectActions}
          key={editor.kind === "edit" ? editor.metadata.id : "create"}
          target={editor}
          hosts={list.hosts}
          defaultHostId={list.defaultHostId ?? null}
          projects={list.projects}
          bots={list.bots}
          projectOwners={list.projectOwners ?? []}
          onClose={() => setEditor(null)}
          onCreate={async (value) => {
            const created = await rpc.call("bot_create", { ...value, sectionId: null });
            // Creation is saved. Close the editor before starting the main
            // chat, so a preparation error cannot create a duplicate bot.
            setEditor(null);
            actions.openMainChat(created);
          }}
          onUpdate={async (value) => {
            if (editor.kind !== "edit") return;
            await rpc.call("bot_update", {
              ...value,
              botId: editor.metadata.id,
              expectedUpdatedAt: editor.metadata.updatedAt,
              expectedStateHashes: editor.metadata.stateHashes,
            });
          }}
        />
      ) : null}
    </TooltipProvider>
  );
  return { actions, dialogs };
}
