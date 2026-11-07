import { memo, type CSSProperties, type ReactNode } from "react";
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

/** What a bot's tile or row shows about its conversations. */
export interface BotSummary {
  attention: number;
  working: boolean;
  /** The bot's latest main-chat reply as one plain line: a row's second line. */
  excerpt: string | null;
  /** The newest conversation was marked complete. */
  finished: boolean;
}

/** A row avatar's badge: new activity wins, then in progress, then finished. */
type BotStatus = "activity" | "progress" | "finished";
const STATUS_LABEL: Record<BotStatus, string> = {
  activity: "New activity",
  progress: "In progress",
  finished: "Finished",
};
function botStatus(summary: BotSummary | undefined): BotStatus | null {
  if (summary === undefined) return null;
  if (summary.attention > 0) return "activity";
  if (summary.working) return "progress";
  return summary.finished ? "finished" : null;
}

/** A shelf of unpinned bots: one per bot section, then unsectioned bots. */
export interface BotShelf {
  key: string;
  label: string;
  bots: readonly BotMetadata[];
}

interface MenuEntry {
  label: string;
  icon: IconName;
  run: () => void;
  disabled?: boolean;
}

/** Unpinned bots on shelves: each bot section in order, then unsectioned bots under Bots. */
export function botShelves(
  bots: readonly BotMetadata[],
  sections: readonly { id: string; name: string; order: number }[],
): BotShelf[] {
  const unpinned = bots.filter((bot) => bot.pinned !== true);
  const known = new Set(sections.map((section) => section.id));
  const shelves: BotShelf[] = [
    ...[...sections]
      .sort((a, b) => a.order - b.order)
      .map((section) => ({
        key: `section:${section.id}`,
        label: section.name,
        bots: unpinned.filter((bot) => bot.sectionId === section.id),
      })),
    {
      key: "bots",
      label: "Bots",
      bots: unpinned.filter((bot) => bot.sectionId === null || !known.has(bot.sectionId)),
    },
  ];
  return shelves.filter((shelf) => shelf.bots.length > 0);
}

/** Pinned bots, three across: each an avatar and a name that opens the bot. */
export function PinnedBotGrid({
  bots,
  threadsByBot,
  activeBotId,
  onOpen,
  actions,
  canMove,
}: {
  bots: readonly BotMetadata[];
  threadsByBot: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  /** The bot that owns the open thread. */
  activeBotId: string | null;
  onOpen: (bot: BotMetadata) => void;
  actions: BotsActions;
  canMove: boolean;
}) {
  if (bots.length === 0) return null;
  return (
    <div className="gtd-bot-grid" aria-label="Pinned bots">
      {bots.map((bot, index) => (
        <BotTile
          key={bot.id}
          bot={bot}
          threads={threadsByBot.get(bot.id) ?? NO_THREADS}
          active={bot.id === activeBotId}
          onOpen={onOpen}
          actions={actions}
          group={bots}
          canMoveUp={canMove && index > 0}
          canMoveDown={canMove && index < bots.length - 1}
        />
      ))}
    </div>
  );
}

const NO_THREADS: readonly PluginSidebarThread[] = [];

const BotTile = memo(function BotTile({
  bot,
  threads,
  active,
  onOpen,
  actions,
  group,
  canMoveUp,
  canMoveDown,
}: {
  bot: BotMetadata;
  threads: readonly PluginSidebarThread[];
  active: boolean;
  onOpen: (bot: BotMetadata) => void;
  actions: BotsActions;
  /** The bots shown beside this one, which Move up/down reorders among. */
  group: readonly BotMetadata[];
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  return (
    <BotMenu
      bot={bot}
      actions={actions}
      group={group}
      canMoveUp={canMoveUp}
      canMoveDown={canMoveDown}
    >
      <button
        type="button"
        className="gtd-bot-tile"
        data-bot-id={bot.id}
        data-active={active || undefined}
        aria-current={active || undefined}
        onClick={() => onOpen(bot)}
        onKeyDown={(event) => openMenuFromKeyboard(event)}
        title={bot.name}
      >
        <BotAvatar bot={bot} threads={threads} size={48} />
        <span className="gtd-bot-tile-name">{bot.name}</span>
      </button>
    </BotMenu>
  );
});

/** An unpinned bot: avatar, name, and its latest main-chat reply. */
export const BotRow = memo(function BotRow({
  bot,
  summary,
  threads,
  active,
  onOpen,
  actions,
  group,
  canMoveUp,
  canMoveDown,
}: {
  bot: BotMetadata;
  summary: BotSummary | undefined;
  threads: readonly PluginSidebarThread[];
  active: boolean;
  onOpen: (bot: BotMetadata) => void;
  actions: BotsActions;
  /** The bots on this row's shelf, which Move up/down reorders among. */
  group: readonly BotMetadata[];
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const status = botStatus(summary);
  return (
    <BotMenu
      bot={bot}
      actions={actions}
      group={group}
      canMoveUp={canMoveUp}
      canMoveDown={canMoveDown}
    >
      <button
        type="button"
        className="gtd-bot-row"
        data-bot-id={bot.id}
        data-active={active || undefined}
        aria-current={active || undefined}
        onClick={() => onOpen(bot)}
        onKeyDown={(event) => openMenuFromKeyboard(event)}
        style={{ "--gtd-bot-color": bot.avatar.color } as CSSProperties}
      >
        <span className="gtd-bot-row-avatar">
          <BotAvatar bot={bot} threads={threads} size={32} />
          {status === null ? null : (
            <span className="gtd-bot-status" data-status={status} title={STATUS_LABEL[status]}>
              {status === "finished" ? <Icon name="Check" className="size-2" /> : null}
            </span>
          )}
        </span>
        <span className="gtd-bot-row-text">
          <span className="gtd-bot-row-name">{bot.name}</span>
          <span className="gtd-bot-row-detail">{summary?.excerpt ?? "No messages yet"}</span>
          {status === null ? null : <span className="sr-only">{STATUS_LABEL[status]}</span>}
        </span>
      </button>
    </BotMenu>
  );
});

function BotAvatar({
  bot,
  threads,
  size,
}: {
  bot: BotMetadata;
  threads: readonly PluginSidebarThread[];
  size: number;
}) {
  const idleVariant =
    [...bot.id].reduce((total, character) => total + character.charCodeAt(0), 0) % 3;
  return (
    <span aria-hidden className="flex shrink-0">
      <SidebarBotIcon
        botId={bot.id}
        avatar={bot.avatar}
        threads={threads}
        idleVariant={idleVariant}
        selected={false}
        size={size}
      />
    </span>
  );
}

function BotMenu({
  bot,
  actions,
  group,
  canMoveUp,
  canMoveDown,
  children,
}: {
  bot: BotMetadata;
  actions: BotsActions;
  group: readonly BotMetadata[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  children: ReactNode;
}) {
  const entries = withoutStraySeparators(botMenu(bot, actions, { canMoveUp, canMoveDown, group }));
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
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
}

/** A bot's own actions: its main chat, new conversations, pinning, settings, visibility, order. */
function botMenu(
  bot: BotMetadata,
  actions: BotsActions,
  options: { canMoveUp: boolean; canMoveDown: boolean; group: readonly BotMetadata[] },
): (MenuEntry | null)[] {
  const hasWork = actions.hasWorkProjects(bot);
  const pinned = bot.pinned === true;
  return [
    { label: "Main chat", icon: "Chat", run: () => actions.openMainChat(bot) },
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
    {
      label: pinned ? "Unpin" : "Pin",
      icon: pinned ? "PinOff" : "Pin",
      run: () => actions.setPinned(bot, !pinned),
    },
    { label: "Edit bot…", icon: "Edit", run: () => actions.editBot(bot) },
    { label: "Manage projects…", icon: "Briefcase", run: () => actions.editBot(bot, "projects") },
    { label: "Routines…", icon: "AlarmClock", run: () => actions.editBot(bot, "routines") },
    { label: "Skills…", icon: "Puzzle", run: () => actions.editBot(bot, "skills") },
    { label: "Hide until activity", icon: "Moon", run: () => actions.setHidden(bot, true) },
    null,
    ...(options.canMoveUp
      ? [
          {
            label: "Move up",
            icon: "ChevronUp" as const,
            run: () => actions.move(bot, "up", options.group),
          },
        ]
      : []),
    ...(options.canMoveDown
      ? [
          {
            label: "Move down",
            icon: "ChevronDown" as const,
            run: () => actions.move(bot, "down", options.group),
          },
        ]
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

/** Placeholders the size of the tiles and rows, while the bots first load. */
export function BotsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading bots">
      <div className="gtd-bot-grid">
        {SKELETON_TILES.map((key) => (
          <div key={key} className="gtd-bot-tile" aria-hidden>
            <span className="gtd-bot-skeleton size-12 rounded-full" />
            <span className="gtd-bot-skeleton h-3 w-10 rounded" />
          </div>
        ))}
      </div>
      {SKELETON_ROWS.map((key) => (
        <div key={key} className="gtd-bot-row" aria-hidden>
          <span className="gtd-bot-skeleton size-8 shrink-0 rounded-full" />
          <span className="gtd-bot-row-text gap-2">
            <span className="gtd-bot-skeleton h-2 w-14 rounded" />
            <span className="gtd-bot-skeleton h-2 w-28 rounded" />
          </span>
        </div>
      ))}
    </div>
  );
}
const SKELETON_TILES = ["a", "b", "c", "d", "e", "f"];
const SKELETON_ROWS = ["a", "b", "c"];

/** The first read failed with nothing saved to show. */
export function BotsError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="gtd-bots-error" role="alert">
      <p className="gtd-bots-error-title">Couldn’t load bots</p>
      <p className="gtd-bots-error-detail">
        The Bots plugin didn’t answer. Your Code tab still works.
      </p>
      <button type="button" className="gtd-bots-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/** A refresh failed; the saved bots stay usable under this line. */
export function BotsOffline({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="gtd-bots-offline" aria-live="polite">
      <span className="gtd-bots-offline-dot" aria-hidden />
      <span className="min-w-0 flex-1 truncate">Showing saved bots</span>
      <button type="button" className="gtd-bots-offline-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
