import { memo, type CSSProperties } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon, type IconName } from "../ui/icon";
import { cn } from "../../lib/utils";
import { MENU_ITEM_CLASS, MenuSurface, openMenuFromKeyboard } from "./menu-surface";
import {
  SidebarBotIcon,
  type BotMetadata,
  type BotsActions,
} from "@smsunarto/bb-plugin-bots/shelf";

/** What one card shows about its bot's conversations. */
export interface BotCardSummary {
  families: number;
  attention: number;
  completed: number;
  working: boolean;
}

interface MenuEntry {
  label: string;
  icon: IconName;
  run: () => void;
  disabled?: boolean;
}

/**
 * The Bots tab's grid: one card per shown bot, then New bot. A card selects
 * its bot, whose conversations list below the grid; its two pills open the
 * bot's latest conversation and start a new one.
 */
export function BotCardGrid({
  bots,
  summaries,
  threadsByBot,
  selectedBotId,
  activeBotId,
  showingCompleted,
  onSelect,
  onOpenLatest,
  onToggleCompleted,
  actions,
  isCompactViewport,
}: {
  bots: readonly BotMetadata[];
  summaries: ReadonlyMap<string, BotCardSummary>;
  threadsByBot: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  selectedBotId: string | null;
  /** The bot that owns the open thread. */
  activeBotId: string | null;
  showingCompleted: ReadonlySet<string>;
  onSelect: (botId: string) => void;
  onOpenLatest: (bot: BotMetadata) => void;
  onToggleCompleted: (botId: string) => void;
  actions: BotsActions;
  isCompactViewport: boolean;
}) {
  return (
    <div className="gtd-bot-grid">
      {bots.map((bot, index) => (
        <BotCard
          key={bot.id}
          bot={bot}
          summary={summaries.get(bot.id) ?? EMPTY_SUMMARY}
          threads={threadsByBot.get(bot.id) ?? NO_THREADS}
          selected={bot.id === selectedBotId}
          active={bot.id === activeBotId}
          showCompleted={showingCompleted.has(bot.id)}
          onSelect={onSelect}
          onOpenLatest={onOpenLatest}
          onToggleCompleted={onToggleCompleted}
          actions={actions}
          canMoveUp={!isCompactViewport && index > 0}
          canMoveDown={!isCompactViewport && index < bots.length - 1}
        />
      ))}
      <button type="button" className="gtd-bot-new" onClick={actions.createBot}>
        <Icon name="Plus" className="size-3.5" />
        New bot
      </button>
    </div>
  );
}

const EMPTY_SUMMARY: BotCardSummary = { families: 0, attention: 0, completed: 0, working: false };
const NO_THREADS: readonly PluginSidebarThread[] = [];

const BotCard = memo(function BotCard({
  bot,
  summary,
  threads,
  selected,
  active,
  showCompleted,
  onSelect,
  onOpenLatest,
  onToggleCompleted,
  actions,
  canMoveUp,
  canMoveDown,
}: {
  bot: BotMetadata;
  summary: BotCardSummary;
  threads: readonly PluginSidebarThread[];
  selected: boolean;
  active: boolean;
  showCompleted: boolean;
  onSelect: (botId: string) => void;
  onOpenLatest: (bot: BotMetadata) => void;
  onToggleCompleted: (botId: string) => void;
  actions: BotsActions;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const { families, attention, completed, working } = summary;
  const entries = withoutStraySeparators(
    botMenu(bot, actions, {
      completed,
      showCompleted,
      onToggleCompleted: () => onToggleCompleted(bot.id),
      canMoveUp,
      canMoveDown,
    }),
  );
  const idleVariant =
    [...bot.id].reduce((total, character) => total + character.charCodeAt(0), 0) % 3;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className="gtd-bot-card"
          data-bot-id={bot.id}
          data-selected={selected || undefined}
          style={{ "--gtd-bot-color": bot.avatar.color } as CSSProperties}
        >
          {/* The whole card selects; the pills sit above this button. */}
          <button
            type="button"
            className="gtd-bot-card-select"
            onClick={() => onSelect(bot.id)}
            onKeyDown={(event) => openMenuFromKeyboard(event)}
            aria-pressed={selected}
            aria-label={`${bot.name}${bot.role ? `, ${bot.role}` : ""}: ${spokenCount(families, attention)}`}
          />
          {attention > 0 ? (
            <span className="gtd-bot-card-badge" data-tone="attention">
              <span className="gtd-bot-card-dot" />
              {attention}
            </span>
          ) : working ? (
            <span className="gtd-bot-card-badge" data-tone="working">
              <span className="gtd-bot-card-dot" />
              Working
            </span>
          ) : null}
          <span className="gtd-bot-card-avatar" aria-hidden>
            <SidebarBotIcon
              botId={bot.id}
              avatar={bot.avatar}
              threads={threads}
              idleVariant={idleVariant}
              selected={active}
              size={64}
            />
          </span>
          <span className="gtd-bot-card-name">{bot.name}</span>
          <span className="gtd-bot-card-role">{bot.role}</span>
          <span className="gtd-bot-card-actions">
            <button
              type="button"
              className="gtd-bot-card-pill"
              data-variant="secondary"
              onClick={() => onOpenLatest(bot)}
              disabled={families === 0}
              aria-label={`Open ${bot.name}’s latest conversation`}
              title={families === 0 ? "No conversations yet" : "Open latest conversation"}
            >
              <Icon name="Chat" className="size-3.5" />
              {families}
            </button>
            <button
              type="button"
              className="gtd-bot-card-pill"
              data-variant="primary"
              onClick={() => actions.newConversation(bot)}
              aria-label={`New conversation with ${bot.name}`}
              title={`New conversation with ${bot.name}`}
            >
              <Icon name="Plus" className="size-3.5" />
              New
            </button>
          </span>
        </div>
      </ContextMenu.Trigger>
      <MenuSurface aria-label={`${bot.name} bot actions`}>
        {entries.map((entry, index) =>
          entry === null ? (
            <ContextMenu.Separator
              key={`separator-after-${entries[index - 1]?.label ?? "start"}`}
              className="mx-2 my-1.5 h-px bg-border"
            />
          ) : (
            <ContextMenu.Item
              key={entry.label}
              disabled={entry.disabled}
              onSelect={entry.run}
              className={cn(MENU_ITEM_CLASS, "data-[highlighted]:text-accent-foreground")}
            >
              <Icon name={entry.icon} className="size-4 shrink-0" />
              {entry.label}
            </ContextMenu.Item>
          ),
        )}
      </MenuSurface>
    </ContextMenu.Root>
  );
});

/** A bot's own actions: new conversations, completed ones, settings, visibility, order. */
function botMenu(
  bot: BotMetadata,
  actions: BotsActions,
  options: {
    completed: number;
    showCompleted: boolean;
    onToggleCompleted: () => void;
    canMoveUp: boolean;
    canMoveDown: boolean;
  },
): (MenuEntry | null)[] {
  const hasWork = actions.hasWorkProjects(bot);
  return [
    { label: "New conversation", icon: "Plus", run: () => actions.newConversation(bot) },
    {
      label: "New conversation in project…",
      icon: "Folder",
      run: () => actions.newInProject(bot, "project"),
      disabled: !hasWork,
    },
    {
      label: "New conversation in worktree…",
      icon: "GitPullRequest",
      run: () => actions.newInProject(bot, "worktree"),
      disabled: !hasWork,
    },
    null,
    ...(options.completed > 0 || options.showCompleted
      ? [
          {
            label: options.showCompleted ? "Hide completed" : `Show ${options.completed} completed`,
            icon: "CheckCircle" as const,
            run: options.onToggleCompleted,
          },
        ]
      : []),
    { label: "Edit bot…", icon: "Edit", run: () => actions.editBot(bot) },
    { label: "Manage projects…", icon: "Briefcase", run: () => actions.editBot(bot, "projects") },
    { label: "Hide until activity", icon: "Moon", run: () => actions.setHidden(bot, true) },
    null,
    ...(options.canMoveUp
      ? [{ label: "Move up", icon: "ChevronUp" as const, run: () => actions.move(bot, "up") }]
      : []),
    ...(options.canMoveDown
      ? [{ label: "Move down", icon: "ChevronDown" as const, run: () => actions.move(bot, "down") }]
      : []),
  ];
}

/** Separators only between two groups of items. */
function withoutStraySeparators(entries: readonly (MenuEntry | null)[]): (MenuEntry | null)[] {
  return entries.filter(
    (entry, index) =>
      entry !== null ||
      (index > 0 &&
        entries[index - 1] !== null &&
        entries.slice(index + 1).some((next) => next !== null)),
  );
}

function spokenCount(families: number, attention: number) {
  const conversations = `${families} ${families === 1 ? "conversation" : "conversations"}`;
  if (attention <= 0) return conversations;
  return `${conversations}, ${attention} ${attention === 1 ? "needs" : "need"} you`;
}
