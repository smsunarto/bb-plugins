import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import { WHITEBOARD_ICON } from "../../shared/contracts/panel.ts";

/**
 * bb empty state for a removed, missing or empty Whiteboard (design §3.8):
 * the panel's own ground, bb's text ladder, an optional action below.
 */
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div
      // <output> takes phrasing content only; this block holds paragraphs and an action.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="status"
      data-wb-empty-state=""
      className="flex h-full min-h-48 w-full flex-col items-center justify-center gap-2 bg-background p-6 text-center"
    >
      <Icon name={WHITEBOARD_ICON} aria-hidden="true" className="size-5 text-subtle-foreground" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-80 text-xs text-muted-foreground">{description}</p> : null}
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}
