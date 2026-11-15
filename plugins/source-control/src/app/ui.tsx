/**
 * Small pieces with no shadcn counterpart. Controls come from
 * `./components/ui/*`.
 */
import { experimental_Icon as Icon, UrlLink } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button.tsx";
import { GitHubMark } from "./page/icons.tsx";
import type { ReactElement, ReactNode } from "react";
import { Spinner } from "./components/ui/spinner.tsx";
import { cx } from "./format.ts";
import { cn } from "./lib/utils.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip.tsx";

const cancelPress = (event: { preventDefault(): void }) => event.preventDefault();

/**
 * For a control beside the composer that acts and leaves the user typing:
 * cancelling the press keeps focus, and a phone's keyboard, in the prompt
 * editor. The action stays on click, and keyboard activation is unchanged.
 */
export const KEEP_COMPOSER_FOCUS = { onPointerDown: cancelPress, onMouseDown: cancelPress };

/** A spinner while `pending`, else the icon, if any. */
export function Pending({ pending, icon }: { pending: boolean; icon?: string }) {
  if (pending) return <Spinner />;
  return icon ? <Icon name={icon} className="size-3.5 shrink-0" aria-hidden /> : null;
}

/**
 * A card's wrapping action, at the panel's 28px control height: 36px under a
 * finger on a phone, as bb's own controls are.
 */
export const CARD_ACTION_CLASS =
  "h-7 min-w-0 flex-[1_1_8rem] max-md:pointer-coarse:h-9 max-md:pointer-coarse:text-[14px]";

/**
 * A quiet text action beside a status line, such as Retry or Open thread:
 * the className for a Button variant="link" size="sm", in muted text.
 */
export const TEXT_LINK =
  "h-auto shrink-0 p-0 text-[12px] leading-4 font-normal text-muted-foreground hover:text-foreground";

/** A folded section's header button: its CollapsibleTrigger, chevron first. */
export const DISCLOSURE =
  "flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent p-0 text-start";

/** A folded section's chevron: down while open, pointing right while closed. */
export function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <Icon
      name="ChevronDown"
      className={cx(
        "size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
        !open && "-rotate-90",
      )}
      aria-hidden
    />
  );
}

/** Merged has no Badge tone: an outline Badge takes the theme's merged colour with this. */
export const MERGED_BADGE = "border-transparent bg-(--pr-merged)/15 text-(--pr-merged)";

/** A small uppercase label over a section. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="m-0 text-[11px] leading-4 font-normal tracking-[0.06em] text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

/**
 * shadcn's Tooltip on one control, for an icon button's name or a disabled
 * control's reason. The tree is the same with or without `label`, so the
 * control keeps its focus when the reason comes and goes. A disabled button
 * takes no pointer or focus: wrap it in a focusable span to explain it.
 */
export function Hint({
  label,
  side,
  children,
}: {
  label: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactElement;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        {label ? <TooltipContent side={side}>{label}</TooltipContent> : null}
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * A control's reason, on hover and keyboard focus: why it is off, or what it
 * does. A disabled button takes neither, so the tooltip sits on a span
 * around it, focusable while `off` (by default, while there is a reason).
 */
export function ReasonHint({
  reason,
  off = Boolean(reason),
  className,
  children,
}: {
  reason: string | null | undefined;
  off?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Hint label={reason}>
      <span
        className={cn("inline-flex min-w-0", className)}
        // Keyboard readers reach the reason here: the disabled control itself takes no focus.
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={off && reason ? 0 : undefined}
      >
        {children}
      </span>
    </Hint>
  );
}

/** The pull request on GitHub: an outlined icon button, opened through bb's link handling. */
export function OpenOnGitHub({ href, label }: { href: string; label: string }) {
  return (
    <Hint label="Open in GitHub">
      {/* UrlLink takes no ref: the tooltip anchors on this span. */}
      <span className="inline-flex shrink-0">
        <Button variant="outline" size="icon" className="size-8" asChild>
          <UrlLink href={href} aria-label={label}>
            <GitHubMark />
          </UrlLink>
        </Button>
      </span>
    </Hint>
  );
}
