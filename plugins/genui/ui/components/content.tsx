import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Value } from "../../core/types";
import { Icon as HostIcon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { resolveIconName } from "../icons";
import { RenderNode } from "../render";
import { useUiRuntime } from "../runtime";
import { isNode, list, optionalText, text, tone, TONE_DOT, TONE_TEXT, type Props, type Tone } from "../values";
import {
  buildTree,
  defaultExpanded,
  keyValuePairs,
  timelineEntries,
  visibleRows,
  type TimelineEntry,
  type TreeRow,
} from "./content-model";
import { ErrorLine } from "./display";
import { FADE, RISE, SMOOTH_HEIGHT_CLASS, useEntrance, useSmoothHeight } from "./motion";

/** A faint wash of the tone behind the note, and the icon that names it. */
const CALLOUT: Record<Tone, { surface: string; icon: string }> = {
  neutral: { surface: "bg-surface-recessed", icon: "Info" },
  info: {
    surface: "bg-[color-mix(in_oklch,var(--color-timeline-accent,var(--primary))_8%,transparent)]",
    icon: "Info",
  },
  good: { surface: "bg-success/8", icon: "CircleCheck" },
  warn: { surface: "bg-warning/10", icon: "AlertTriangle" },
  bad: { surface: "bg-destructive/8", icon: "CircleX" },
};

export function Callout({ props }: { props: Props }) {
  const ref = useEntrance<HTMLDivElement>(FADE);
  const toneName = tone(props.tone);
  const title = optionalText(props.title);
  const body = text(props.text);
  if (body === "" && !title) return null;
  return (
    <div
      ref={ref}
      role="note"
      className={cn(
        "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2.5 rounded-lg px-3.5 py-3 text-sm leading-5 text-foreground",
        CALLOUT[toneName].surface,
      )}
    >
      <HostIcon
        name={CALLOUT[toneName].icon}
        fallback="Info"
        aria-hidden
        className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[toneName] || "text-muted-foreground")}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        {title ? <p className="m-0 font-medium text-foreground">{title}</p> : null}
        {body === "" ? null : (
          <Markdown content={body} className="min-w-0 text-sm [&>:first-child]:mt-0 [&>:last-child]:mb-0" />
        )}
      </div>
    </div>
  );
}

/** A host icon at the surrounding text size; names BB doesn't draw show nothing, never the host's Zap. */
export function Icon({ props }: { props: Props }) {
  const name = resolveIconName(text(props.name));
  if (name === null) return null;
  return (
    <HostIcon
      name={name}
      aria-hidden
      className={cn("inline-block size-[1em] shrink-0 align-[-0.125em]", TONE_TEXT[tone(props.tone)])}
    />
  );
}

/** Models write `**bold**`, `code` and links in values as they would in a table cell. */
const INLINE_MARKDOWN = /\*\*|__|`|\[[^\]]*\]\(/;

function PairValue({ value }: { value: Value }): ReactNode {
  if (isNode(value)) return <RenderNode node={value} />;
  if (value === null) return <span className="text-muted-foreground">—</span>;
  if (Array.isArray(value)) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        {value.map((item: Value, index) => (
          <PairValue key={isNode(item) ? item.key : index} value={item} />
        ))}
      </span>
    );
  }
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number") return <span className="tabular-nums">{String(value)}</span>;
  if (typeof value === "string" && INLINE_MARKDOWN.test(value)) {
    return <Markdown content={value} className="text-sm [&_p]:m-0" />;
  }
  return String(value);
}

/**
 * A definition list: labels and values in two aligned columns where the
 * container is wide enough, each label above its value where it is not.
 */
export function KeyValue({ props }: { props: Props }) {
  const pairs = keyValuePairs(props.pairs);
  if (pairs === null) return <ErrorLine message="KeyValue needs an object or a list of [label, value] pairs" />;
  if (pairs.length === 0) return null;
  return (
    <div className="@container min-w-0">
      <dl className="m-0 grid min-w-0 grid-cols-1 text-sm leading-5 @sm:grid-cols-[fit-content(40%)_minmax(0,1fr)] @sm:gap-x-6">
        {pairs.map(([label, value], index) => (
          <div
            key={index}
            className="col-span-full grid grid-cols-subgrid gap-y-0.5 border-b border-border/60 py-2 first:pt-0 last:border-b-0 last:pb-0"
          >
            <dt className="min-w-0 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere] @sm:text-sm">
              {label}
            </dt>
            <dd className="m-0 min-w-0 text-foreground [overflow-wrap:anywhere]">
              <PairValue value={value} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TimelineItem({ entry, last, timed }: { entry: TimelineEntry; last: boolean; timed: boolean }) {
  const ref = useEntrance<HTMLLIElement>(RISE);
  return (
    <li ref={ref} className="col-span-full grid grid-cols-subgrid">
      {/* Wide containers give times their own column; narrow ones put them above the title. */}
      {timed ? (
        <span className="hidden text-xs leading-5 text-muted-foreground tabular-nums [overflow-wrap:anywhere] @sm:block">
          {entry.time}
        </span>
      ) : null}
      <div aria-hidden className="flex flex-col items-center">
        <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", TONE_DOT[entry.tone])} />
        {last ? null : <span className="mt-1.5 w-px flex-1 bg-border" />}
      </div>
      <div className={cn("flex min-w-0 flex-col gap-0.5", !last && "pb-4")}>
        {entry.time === null ? null : (
          <span className="text-xs leading-4 text-muted-foreground tabular-nums @sm:hidden">{entry.time}</span>
        )}
        {entry.title === "" ? null : (
          <span className="text-sm font-medium leading-5 text-foreground [overflow-wrap:anywhere]">{entry.title}</span>
        )}
        {entry.detail === null ? null : (
          <span className="text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">{entry.detail}</span>
        )}
      </div>
    </li>
  );
}

/** Events down a line: time, a tone-colored dot, title and a muted detail. */
export function Timeline({ props }: { props: Props }) {
  const items = list(props.items);
  const entries = timelineEntries(items);
  if (entries.length === 0) {
    return items.length === 0 ? null : <ErrorLine message="Timeline items need a title or a time" />;
  }
  const timed = entries.some((entry) => entry.time !== null);
  return (
    <div className="@container min-w-0">
      <ol
        className={cn(
          "m-0 grid min-w-0 list-none grid-cols-[0.5rem_minmax(0,1fr)] gap-x-3 p-0",
          timed && "@sm:grid-cols-[fit-content(32%)_0.5rem_minmax(0,1fr)]",
        )}
      >
        {entries.map((entry, index) => (
          <TimelineItem key={index} entry={entry} last={index === entries.length - 1} timed={timed} />
        ))}
      </ol>
    </div>
  );
}

/** Per tree level, in px. */
const INDENT = 16;
/** Row padding before the chevron, in px. */
const ROW_PAD = 4;
/** Half the 14px chevron slot: where a level's guide line runs. */
const GUIDE_OFFSET = ROW_PAD + 7;

/**
 * A collapsible file or outline tree. Rows are flat treeitems (level, set
 * size and position in aria-*) with one roving tab stop and the usual
 * arrow, Home/End and Enter/Space keys. Files from path strings open in
 * the host's file viewer where there is one.
 */
export function Tree({ props }: { props: Props }) {
  const { openFile } = useUiRuntime();
  const fade = useEntrance<HTMLDivElement>(FADE);
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();
  const items = list(props.items);
  const roots = useMemo(() => buildTree(items), [props.items]);
  // A folder that once opened by default stays open while more items stream in.
  const openedByDefault = useRef(new Set<string>());
  const defaults = useMemo(() => {
    for (const id of defaultExpanded(roots)) openedByDefault.current.add(id);
    return openedByDefault.current;
  }, [roots]);
  /** The user's own opens and closes, which win over the defaults. */
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [focused, setFocused] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  if (roots.length === 0) {
    return items.length === 0 ? null : <ErrorLine message='Tree items need paths like "src/a.ts" or {label}' />;
  }

  const isOpen = (id: string) => toggled.get(id) ?? defaults.has(id);
  const rows = visibleRows(roots, isOpen);
  const tabStop = rows.some((row) => row.item.id === focused) ? focused : rows[0].item.id;
  const setOpen = (id: string, open: boolean) => setToggled((previous) => new Map(previous).set(id, open));
  const focusRow = (row: TreeRow | undefined) => {
    if (row === undefined) return;
    setFocused(row.item.id);
    rowRefs.current.get(row.item.id)?.focus();
  };

  const activate = async (row: TreeRow) => {
    const { item } = row;
    if (item.folder) {
      setOpen(item.id, !isOpen(item.id));
      return;
    }
    if (item.path === null || openFile === null) return;
    let opened = false;
    try {
      opened = await openFile(item.path);
    } catch {
      opened = false;
    }
    if (!opened) toast.error(`Couldn't open ${item.path}`);
  };

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const row = rows[index];
    const { item } = row;
    switch (event.key) {
      case "ArrowDown":
        focusRow(rows[index + 1]);
        break;
      case "ArrowUp":
        focusRow(rows[index - 1]);
        break;
      case "Home":
        focusRow(rows[0]);
        break;
      case "End":
        focusRow(rows[rows.length - 1]);
        break;
      case "ArrowRight":
        if (!item.folder) break;
        if (!isOpen(item.id)) setOpen(item.id, true);
        else if (rows[index + 1]?.parent === item.id) focusRow(rows[index + 1]);
        break;
      case "ArrowLeft":
        if (item.folder && isOpen(item.id)) setOpen(item.id, false);
        else focusRow(rows.find((candidate) => candidate.item.id === row.parent));
        break;
      case "Enter":
      case " ":
        void activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const hasPaths = rows.some((row) => row.item.path !== null);
  return (
    <div
      ref={(element) => {
        fade.current = element;
        outer.current = element;
      }}
      className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}
    >
      <div ref={inner} role="tree" aria-label={hasPaths ? "Files" : undefined} className="flex min-w-0 flex-col">
        {rows.map((row, index) => {
          const { item } = row;
          const open = item.folder && isOpen(item.id);
          const interactive = item.folder || (item.path !== null && openFile !== null);
          return (
            <div
              key={item.id}
              ref={(element) => {
                if (element === null) rowRefs.current.delete(item.id);
                else rowRefs.current.set(item.id, element);
              }}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-setsize={row.siblings}
              aria-posinset={row.position}
              aria-expanded={item.folder ? open : undefined}
              tabIndex={item.id === tabStop ? 0 : -1}
              title={item.path ?? undefined}
              onFocus={() => setFocused(item.id)}
              onClick={() => void activate(row)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "relative flex h-7 min-w-0 shrink-0 select-none items-center gap-1.5 rounded-md pr-1.5 text-[13px] leading-5 text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                interactive && "cursor-pointer hover:bg-muted/60",
              )}
              style={{ paddingLeft: row.depth * INDENT + ROW_PAD }}
            >
              {Array.from({ length: row.depth }, (_, level) => (
                <span
                  key={level}
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 w-px bg-border"
                  style={{ left: level * INDENT + GUIDE_OFFSET }}
                />
              ))}
              <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
                {item.folder ? (
                  <HostIcon
                    name="ChevronRight"
                    aria-hidden
                    className={cn(
                      "size-3 transition-transform duration-150 motion-reduce:transition-none",
                      open && "rotate-90",
                    )}
                  />
                ) : null}
              </span>
              <HostIcon
                name={item.folder ? (open ? "FolderOpen" : "Folder") : "File"}
                fallback={item.folder ? "Folder" : "File"}
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.note === null ? null : isNode(item.note) ? (
                <span className="flex max-w-[50%] shrink-0 items-center overflow-hidden">
                  <RenderNode node={item.note} />
                </span>
              ) : (
                <span className="max-w-[50%] shrink-0 truncate text-xs text-muted-foreground tabular-nums">
                  {text(item.note)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
