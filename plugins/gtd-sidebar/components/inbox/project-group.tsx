import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { FadingText } from "@/components/inbox/thread-details";

/**
 * One project inside a shelf: a header naming the project, then its rows.
 *
 * The shelf still answers the larger question (can the user act?), so the
 * header carries only the project name. The count shows while the group is
 * folded, where it is the group's whole footprint: `needs-you / total` when
 * something in it asks for the user, the total alone otherwise. Hovering the
 * header trades the count for a new-thread button.
 *
 * Right-clicking the header offers "Move up" / "Move down", which reorder the
 * project in bb's own order — the same order every shelf groups by — so the
 * move lands identically under each shelf.
 */
export function ProjectGroup({
  projectId,
  name,
  families,
  attention,
  expanded,
  onToggle,
  onNewThread,
  onMoveUp,
  onMoveDown,
  isCompactViewport,
  children,
}: {
  projectId: string;
  name: string;
  families: number;
  attention: number;
  expanded: boolean;
  onToggle: () => void;
  onNewThread: (projectId: string) => void;
  /** Move handlers, absent where the move cannot run (edge groups, personal). */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  isCompactViewport: boolean;
  children: ReactNode;
}) {
  const count = attention > 0 ? `${attention} / ${families}` : `${families}`;
  const header = (
    <div
      className={cn(
        "gtd-project-group-header group/pg",
        isCompactViewport && "gtd-project-group-header-touch",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${name} project${expanded ? "" : ` (${count})`}`}
        className="gtd-project-group-toggle"
      >
        <span className="gtd-disclosure gtd-project-group-chevron">
          <Icon
            name="ChevronDown"
            className={cn("size-3 transition-transform", !expanded && "-rotate-90")}
          />
        </span>
        <FadingText text={name} className="gtd-project-group-name" />
        {expanded ? null : (
          <span
            className={cn("gtd-project-group-count", attention > 0 && "gtd-project-group-attn")}
          >
            {count}
          </span>
        )}
      </button>
      {isCompactViewport ? null : (
        <button
          type="button"
          aria-label={`New thread in ${name}`}
          title={`New thread in ${name}`}
          onClick={() => onNewThread(projectId)}
          className="gtd-project-group-new"
        >
          <Icon name="Plus" className="size-3" />
        </button>
      )}
    </div>
  );
  return (
    <div className="gtd-project-group" data-project-id={projectId}>
      {onMoveUp === undefined && onMoveDown === undefined ? (
        header
      ) : (
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>{header}</ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content
              {...usePortalScopeProps()}
              aria-label={`${name} project actions`}
              className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
            >
              {onMoveUp === undefined ? null : (
                <ContextMenu.Item
                  onSelect={onMoveUp}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                >
                  <Icon name="ChevronUp" className="size-4 shrink-0" />
                  Move up
                </ContextMenu.Item>
              )}
              {onMoveDown === undefined ? null : (
                <ContextMenu.Item
                  onSelect={onMoveDown}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                >
                  <Icon name="ChevronDown" className="size-4 shrink-0" />
                  Move down
                </ContextMenu.Item>
              )}
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      )}
      {expanded ? (
        <ul className="gtd-project-group-rows flex flex-col gap-0.5">{children}</ul>
      ) : null}
    </div>
  );
}
