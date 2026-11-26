import {
  useHeaderBarSnapshot,
  usePublishHeaderBarSegments,
  type HeaderBarClickOptions,
  type HeaderBarMenu,
  type HeaderBarSegment,
} from "@bb-plugins/header-bar";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  type ExperimentalThreadHeaderRowProps,
} from "@get-bb/plugin-sdk/app";
import { Fragment, useCallback, useMemo, type MouseEvent } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Icon } from "../components/ui/icon.tsx";
import { Separator } from "../components/ui/separator.tsx";
import { cn } from "../lib/utils.ts";
import { StatusBarGlyph, toneTextClass } from "./glyphs.tsx";
import { buildKitchenSinkHeaderSegments } from "./lineage.ts";

const PLUGIN_SCOPE_PROPS = {
  "data-bb-plugin": "kitchen-sink",
  "data-bb-plugin-scope-kitchen-sink": "",
} as const;

const INTERACTIVE_ITEM =
  "inline-flex h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:h-11 max-md:pointer-coarse:min-w-11 max-md:pointer-coarse:px-2.5";

function clickOptions(event: MouseEvent): HeaderBarClickOptions | undefined {
  return event.metaKey || event.ctrlKey ? { split: true } : undefined;
}

/**
 * Unified Vim-style thread statusbar directly under the thread header.
 *
 * Publishes Kitchen Sink's own fallback lineage/subthread segments and renders
 * the winning segments across all participating plugins in one 32px row with
 * fixed left (`lineage`, `task`) and right (`meta`, `threads`, `action`) zones.
 * Returns `null` when every slot is empty so normal threads stay at 0px.
 */
export function HeaderStatusBar({ threadId }: ExperimentalThreadHeaderRowProps) {
  const { threads } = useSidebarThreads();
  const navigate = useBbNavigate();

  const onOpenThread = useCallback(
    (targetId: string, options?: HeaderBarClickOptions) => {
      if (options?.split) {
        navigate.toThread(targetId, { split: true });
        return;
      }
      navigate.toThread(targetId);
    },
    [navigate],
  );

  const ownSegments = useMemo(
    () => buildKitchenSinkHeaderSegments({ threadId, threads, onOpenThread }),
    [threadId, threads, onOpenThread],
  );

  usePublishHeaderBarSegments(threadId, "kitchen-sink", ownSegments);

  const bar = useHeaderBarSnapshot(threadId);
  if (bar.isEmpty) return null;

  const segments = [...bar.left, ...bar.right];

  return (
    <section
      aria-label="Thread status"
      {...PLUGIN_SCOPE_PROPS}
      data-kitchen-sink-header-bar=""
      data-testid="thread-header-status-bar"
      className="flex h-8 w-full min-w-0 items-center justify-start gap-1.5 overflow-hidden border-b border-border bg-background/80 px-2.5 text-xs text-foreground whitespace-nowrap select-none max-md:pointer-coarse:h-11 max-md:pointer-coarse:px-2"
    >
      {segments.map((segment, index) => (
        <Fragment key={`${segment.slot}:${segment.owner}`}>
          {index > 0 ? <Separator orientation="vertical" className="h-3.5 shrink-0" /> : null}
          <SegmentView segment={segment} />
        </Fragment>
      ))}
    </section>
  );
}

function SegmentView({ segment }: { readonly segment: HeaderBarSegment }) {
  if (segment.menu !== undefined) {
    return (
      <div
        data-header-bar-slot={segment.slot}
        data-header-bar-owner={segment.owner}
        data-testid={segment.testId}
        className="flex shrink-0 items-center"
      >
        <SegmentMenu menu={segment.menu} />
      </div>
    );
  }

  const content = <SegmentBody segment={segment} />;
  const shrinkClass = segment.shrink ? "min-w-0 shrink overflow-hidden" : "shrink-0";

  return (
    <div
      data-header-bar-slot={segment.slot}
      data-header-bar-owner={segment.owner}
      className={cn("flex items-center gap-1", shrinkClass)}
    >
      {segment.onClick !== undefined ? (
        <button
          type="button"
          aria-label={segment.ariaLabel ?? segment.label}
          title={segment.title ?? segment.ariaLabel ?? segment.label}
          data-testid={segment.testId}
          onClick={(event) => segment.onClick?.(clickOptions(event))}
          className={cn(
            INTERACTIVE_ITEM,
            toneTextClass(segment.tone),
            segment.shrink ? "min-w-0 shrink" : "shrink-0",
          )}
        >
          {content}
        </button>
      ) : (
        <span
          aria-label={segment.ariaLabel}
          title={segment.title}
          data-testid={segment.testId}
          className={cn(
            "inline-flex h-6 min-w-0 items-center gap-1.5 px-1 text-xs",
            toneTextClass(segment.tone ?? "muted"),
            segment.shrink ? "min-w-0 shrink" : "shrink-0",
          )}
        >
          {content}
        </span>
      )}
      {segment.secondaryMenu !== undefined ? (
        <SegmentMenu menu={segment.secondaryMenu} compact />
      ) : null}
    </div>
  );
}

function SegmentBody({ segment }: { readonly segment: HeaderBarSegment }) {
  return (
    <>
      {segment.prefixIcon !== undefined ? (
        <Icon name={segment.prefixIcon} aria-hidden className="size-3 shrink-0 opacity-80" />
      ) : null}
      {segment.glyph !== undefined ? <StatusBarGlyph glyph={segment.glyph} /> : null}
      {segment.keyText !== undefined ? (
        <span className="shrink-0 font-mono text-[11px] font-medium text-muted-foreground">
          {segment.keyText}
        </span>
      ) : null}
      {segment.label !== undefined ? (
        <span
          className={cn(
            "min-w-0 truncate",
            segment.keyText !== undefined ? "font-medium text-foreground" : undefined,
          )}
        >
          {segment.label}
        </span>
      ) : null}
      {segment.tagGlyph !== undefined ? <StatusBarGlyph glyph={segment.tagGlyph} /> : null}
      {segment.tag !== undefined ? (
        <span
          className={cn(
            "shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[11px] leading-none",
            toneTextClass(segment.tagTone ?? "muted"),
          )}
        >
          {segment.tag}
        </span>
      ) : null}
    </>
  );
}

function SegmentMenu({
  menu,
  compact = false,
}: {
  readonly menu: HeaderBarMenu;
  readonly compact?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={menu.ariaLabel}
          title={menu.title ?? menu.ariaLabel}
          data-testid={menu.testId}
          className={cn(
            INTERACTIVE_ITEM,
            "shrink-0",
            toneTextClass(menu.tone ?? "muted"),
            compact &&
              "h-5 bg-surface-raised px-1.5 font-mono text-[11px] hover:bg-state-hover max-md:pointer-coarse:h-11",
          )}
        >
          {menu.glyph !== undefined ? <StatusBarGlyph glyph={menu.glyph} /> : null}
          <span className="whitespace-nowrap">{menu.triggerLabel}</span>
          <Icon name="ChevronDown" aria-hidden className="size-3 shrink-0 opacity-75" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="max-h-72 min-w-56 max-w-80 overflow-y-auto"
        {...PLUGIN_SCOPE_PROPS}
      >
        {menu.heading !== undefined ? <DropdownMenuLabel>{menu.heading}</DropdownMenuLabel> : null}
        {menu.items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            disabled={item.disabled}
            onSelect={() => item.onSelect()}
            className="flex items-center gap-2 text-xs"
          >
            {item.glyph !== undefined ? <StatusBarGlyph glyph={item.glyph} /> : null}
            {item.keyText !== undefined ? (
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {item.keyText}
              </span>
            ) : null}
            <span className={cn("min-w-0 flex-1 truncate", item.active && "font-medium")}>
              {item.label}
            </span>
            {item.detail !== undefined ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">{item.detail}</span>
            ) : null}
            {item.trailingGlyph !== undefined ? (
              <StatusBarGlyph glyph={item.trailingGlyph} />
            ) : null}
            {item.active ? (
              <Icon name="Check" aria-hidden className="size-3.5 shrink-0 text-foreground" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
