import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
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
 * The header is sticky under its shelf header, so a long group keeps its name
 * in view while its rows scroll.
 */
export function ProjectGroup({
  projectId,
  name,
  families,
  attention,
  expanded,
  onToggle,
  onNewThread,
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
  isCompactViewport: boolean;
  children: ReactNode;
}) {
  const count = attention > 0 ? `${attention} / ${families}` : `${families}`;
  return (
    <div className="gtd-project-group" data-project-id={projectId}>
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
      {expanded ? (
        <ul className="gtd-project-group-rows flex flex-col gap-0.5">{children}</ul>
      ) : null}
    </div>
  );
}
