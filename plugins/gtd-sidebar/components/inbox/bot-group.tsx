import { useState, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon, type IconName } from "../ui/icon";
import { cn } from "../../lib/utils";
import { FadingText } from "./thread-details";
import { MENU_ITEM_CLASS, MenuSurface, openMenuFromKeyboard } from "./menu-surface";
import { SlidingDisclosure } from "./sliding-disclosure";
import type { HeaderMeasureProps } from "../../hooks/use-inbox-window";
import {
  SidebarBotIcon,
  type BotMetadata,
  type BotsActions,
} from "@smsunarto/bb-plugin-bots/shelf";

interface MenuEntry {
  label: string;
  icon: IconName;
  run: () => void;
  disabled?: boolean;
}

/**
 * One bot on the Bots shelf, drawn as a project group: the bot's avatar in
 * the folder's glyph column, its name, and its conversations as ordinary
 * thread cards below. The avatar swaps for the fold chevron on hover, the
 * count shows while folded, and hovering trades the count for a
 * new-conversation button, as a project header does.
 *
 * Right-click (or Shift+F10) opens the bot's own actions: new conversations,
 * completed conversations, settings, visibility, and order.
 */
export function BotGroup({
  bot,
  threads,
  families,
  attention,
  completed,
  showCompleted,
  onToggleCompleted,
  expanded,
  onToggle,
  actions,
  canMoveUp,
  canMoveDown,
  selected,
  isCompactViewport,
  measureRef,
  measureIndex,
  children,
}: {
  bot: BotMetadata;
  /** The bot's live conversations, for its avatar's working and idle faces. */
  threads: readonly PluginSidebarThread[];
  families: number;
  attention: number;
  completed: number;
  showCompleted: boolean;
  onToggleCompleted: () => void;
  expanded: boolean;
  onToggle: () => void;
  actions: BotsActions;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** The open thread is one of this bot's. */
  selected: boolean;
  isCompactViewport: boolean;
  children: ReactNode;
} & HeaderMeasureProps) {
  const [hovered, setHovered] = useState(false);
  const [newFocusVisible, setNewFocusVisible] = useState(false);
  const [toggleFocusVisible, setToggleFocusVisible] = useState(false);
  const showChevron = hovered || toggleFocusVisible;
  const count = attention > 0 ? `${attention} / ${families}` : `${families}`;
  const hasWork = actions.hasWorkProjects(bot);
  const menu: (MenuEntry | null)[] = [
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
    ...(completed > 0 || showCompleted
      ? [
          {
            label: showCompleted ? "Hide completed" : `Show ${completed} completed`,
            icon: "CheckCircle" as const,
            run: onToggleCompleted,
          },
        ]
      : []),
    { label: "Edit bot…", icon: "Edit", run: () => actions.editBot(bot) },
    { label: "Manage projects…", icon: "Briefcase", run: () => actions.editBot(bot, "projects") },
    { label: "Routines…", icon: "AlarmClock", run: () => actions.editBot(bot, "routines") },
    { label: "Hide until activity", icon: "Moon", run: () => actions.setHidden(bot, true) },
    null,
    ...(canMoveUp
      ? [{ label: "Move up", icon: "ChevronUp" as const, run: () => actions.move(bot, "up") }]
      : []),
    ...(canMoveDown
      ? [{ label: "Move down", icon: "ChevronDown" as const, run: () => actions.move(bot, "down") }]
      : []),
  ];
  const entries = withoutStraySeparators(menu);
  const idleVariant =
    [...bot.id].reduce((total, character) => total + character.charCodeAt(0), 0) % 3;
  const header = (
    <div
      ref={measureRef}
      data-index={measureIndex}
      className={cn(
        "gtd-project-group-header gtd-bot-group-header",
        isCompactViewport && "gtd-project-group-header-touch",
      )}
      data-selected={selected || undefined}
      data-new-focus-visible={newFocusVisible}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      onPointerCancel={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={onToggle}
        onFocus={(event) => setToggleFocusVisible(event.currentTarget.matches(":focus-visible"))}
        onBlur={() => setToggleFocusVisible(false)}
        onKeyDown={(event) => openMenuFromKeyboard(event)}
        aria-expanded={expanded}
        aria-label={`${bot.name} bot${expanded ? "" : `, ${spokenCount(families, attention)}`}`}
        title={bot.role ? `${bot.name} · ${bot.role}` : bot.name}
        className="gtd-project-group-toggle"
      >
        <span className="gtd-disclosure gtd-project-group-chevron">
          {showChevron ? (
            <Icon
              name="ChevronDown"
              className={cn(
                "gtd-chevron-motion",
                isCompactViewport ? "size-4" : "size-3",
                !expanded && "-rotate-90",
              )}
            />
          ) : (
            <SidebarBotIcon
              botId={bot.id}
              avatar={bot.avatar}
              threads={threads}
              idleVariant={idleVariant}
              selected={selected}
              size={isCompactViewport ? 20 : 18}
            />
          )}
        </span>
        <FadingText text={bot.name} className="gtd-project-group-name" />
        {bot.role ? <span className="gtd-bot-group-role">{bot.role}</span> : null}
        {expanded ? null : (
          <span
            className={cn("gtd-project-group-count", attention > 0 && "gtd-project-group-attn")}
          >
            {count}
          </span>
        )}
      </button>
      <button
        type="button"
        aria-label={`New conversation with ${bot.name}`}
        title={`New conversation with ${bot.name}`}
        onClick={() => actions.newConversation(bot)}
        onFocus={(event) => setNewFocusVisible(event.currentTarget.matches(":focus-visible"))}
        onBlur={() => setNewFocusVisible(false)}
        className="gtd-project-group-new"
      >
        <Icon name="Plus" className="size-3" />
      </button>
    </div>
  );
  return (
    <div className="gtd-project-group" data-bot-id={bot.id}>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{header}</ContextMenu.Trigger>
        <MenuSurface aria-label={`${bot.name} bot actions`}>
          {entries.map((entry, index) =>
            entry === null ? (
              <ContextMenu.Separator
                key={`separator-after-${menuKey(entries, index)}`}
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
      <SlidingDisclosure open={expanded}>
        <ul className="gtd-project-group-rows flex flex-col">{children}</ul>
      </SlidingDisclosure>
    </div>
  );
}

/** A separator's key: the label of the item above it. */
function menuKey(entries: readonly (MenuEntry | null)[], index: number): string {
  return entries[index - 1]?.label ?? "start";
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
