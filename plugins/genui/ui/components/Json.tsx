// A JSON explorer: the value as a tree whose containers open and close,
// scalars coloured by type, every value and path one click (or key) from the
// clipboard. Rows follow the ARIA tree pattern with one roving tab stop; only
// open containers render children, and long ones page in a hundred at a time.
import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { Value } from "../../core/types";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useUiRuntime } from "../runtime";
import { formatNumber, optionalText, type Props } from "../values";
import { FOCUS_RING } from "./inputs";
import {
  CHILD_PAGE,
  copyText,
  defaultOpen,
  jsonKind,
  sizeText,
  STRING_PREVIEW,
  visibleRows,
  type JsonKind,
  type JsonRow,
} from "./json-logic";
import { FADE, SMOOTH_HEIGHT_CLASS, useEntrance, useSmoothHeight } from "./motion";

/** Per tree level, in px. */
const INDENT = 14;
/** Row padding before the chevron, in px. */
const ROW_PAD = 6;
/** Half the 14px chevron slot: where a level's guide line runs. */
const GUIDE_OFFSET = ROW_PAD + 7;

/** Scalar colours by type; containers draw their own brackets. */
const SCALAR_CLASS: Record<JsonKind, string> = {
  object: "",
  array: "",
  string: "text-success",
  number: "text-[var(--color-timeline-accent,var(--primary))]",
  boolean: "text-warning-text",
  null: "italic text-muted-foreground",
};

const ROW_ACTION = cn(
  "inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 font-sans text-[10.5px] text-muted-foreground transition-colors duration-150 hover:bg-background hover:text-foreground",
  FOCUS_RING,
);

const ICON_BUTTON = cn(
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-background hover:text-foreground",
  FOCUS_RING,
);

function isContainer(kind: JsonKind): boolean {
  return kind === "object" || kind === "array";
}

/** A scalar as it reads in JSON. Strings longer than STRING_PREVIEW are cut; expanded (`full`), a long string shows its own line breaks. */
function ScalarText({ value, kind, full, onToggle }: { value: Value; kind: JsonKind; full: boolean; onToggle: () => void }) {
  if (kind !== "string") {
    return <span className={SCALAR_CLASS[kind]}>{String(value)}</span>;
  }
  const quoted = JSON.stringify(value);
  const cut = quoted.length > STRING_PREVIEW + 2 && !full;
  return (
    <>
      <span className={cn(SCALAR_CLASS.string, "[overflow-wrap:anywhere]", full ? "whitespace-pre-wrap" : null)}>
        {cut ? `${quoted.slice(0, STRING_PREVIEW + 1)}…` : full && typeof value === "string" ? `"${value}"` : quoted}
      </span>
      {quoted.length > STRING_PREVIEW + 2 ? (
        <button
          type="button"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          className={cn(ROW_ACTION, "ml-1 align-baseline")}
        >
          {full ? "less" : `+${formatNumber(quoted.length - STRING_PREVIEW - 2)} chars`}
        </button>
      ) : null}
    </>
  );
}

function ContainerSummary({ value, kind, open }: { value: Value; kind: JsonKind; open: boolean }) {
  const size = sizeText(value);
  const empty = size.startsWith("0 ");
  const brackets = kind === "array" ? ["[", "]"] : ["{", "}"];
  return (
    <span className="text-muted-foreground">
      {empty ? `${brackets[0]}${brackets[1]}` : open ? brackets[0] : `${brackets[0]}…${brackets[1]}`}
      <span className="ml-1.5 font-sans text-[11px]">{empty ? "empty" : size}</span>
    </span>
  );
}

export function Json({ props }: { props: Props }) {
  const { run } = useUiRuntime();
  const fade = useEntrance<HTMLDivElement>(FADE);
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();
  const value: Value = props.value ?? null;
  const label = optionalText(props.label);
  /** The user's opens and closes; the top level shows by default and nothing below it does. */
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [pages, setPages] = useState<ReadonlyMap<string, number>>(new Map());
  const [fullStrings, setFullStrings] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  // A lone container under the root (and down) opens by default; the user's own toggles win.
  const defaults = useMemo(() => defaultOpen(value), [value]);
  const isOpen = (id: string) => open.get(id) ?? defaults.has(id);
  const shown = (id: string) => pages.get(id) ?? CHILD_PAGE;
  // `open`, `pages` and the defaults are the only inputs besides the value.
  const rows = useMemo(() => visibleRows(value, isOpen, shown), [value, open, pages, defaults]);
  const rootKind = jsonKind(value);
  const tabStop = rows.some((row) => row.id === focused) ? focused : (rows[0]?.id ?? null);

  const copy = (text: string) => void run([{ kind: "action", type: "copy", text }]);
  const setRowOpen = (id: string, next: boolean) => setOpen((previous) => new Map(previous).set(id, next));
  const toggleString = (id: string) =>
    setFullStrings((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const showMore = (row: Extract<JsonRow, { type: "more" }>) =>
    setPages((previous) => new Map(previous).set(row.parent, row.shown + CHILD_PAGE));
  const focusRow = (row: JsonRow | undefined) => {
    if (row === undefined) return;
    setFocused(row.id);
    rowRefs.current.get(row.id)?.focus();
  };

  const activate = (row: JsonRow) => {
    if (row.type === "more") showMore(row);
    else if (row.children > 0) setRowOpen(row.id, !isOpen(row.id));
    else copy(copyText(row.value));
  };

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const row = rows[index];
    if (event.metaKey || event.ctrlKey || event.altKey) {
      // ⌘C / Ctrl+C copies the focused value, as a selection would.
      if (row.type === "value" && event.key.toLowerCase() === "c" && !event.altKey) copy(copyText(row.value));
      else return;
      event.preventDefault();
      return;
    }
    const container = row.type === "value" && row.children > 0;
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
      case "ArrowRight": {
        const next = rows[index + 1];
        if (container && !isOpen(row.id)) setRowOpen(row.id, true);
        else if (container && next?.type === "value" && next.parent === row.id) focusRow(next);
        else if (row.type === "value" && row.kind === "string" && !fullStrings.has(row.id)) toggleString(row.id);
        break;
      }
      case "ArrowLeft": {
        if (container && isOpen(row.id)) setRowOpen(row.id, false);
        else if (row.type === "value" && fullStrings.has(row.id)) toggleString(row.id);
        else focusRow(rows.find((candidate) => candidate.id === row.parent));
        break;
      }
      case "Enter":
      case " ":
        activate(row);
        break;
      case "c":
        if (row.type === "value") copy(copyText(row.value));
        break;
      case "p":
        if (row.type === "value") copy(row.id);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const caption = isContainer(rootKind) ? `${rootKind} · ${sizeText(value)}` : rootKind;
  return (
    <div ref={fade} className="min-w-0 overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex h-8 items-center justify-between gap-3 border-b border-border bg-surface-recessed pl-3 pr-1.5 text-[11px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-foreground">{label ?? "JSON"}</span>
          <span className="shrink-0 tabular-nums">{caption}</span>
        </span>
        <button
          type="button"
          title="Copy JSON"
          aria-label={`Copy ${label ?? "the JSON"}`}
          onClick={() => copy(JSON.stringify(value, null, 2))}
          className={ICON_BUTTON}
        >
          <Icon name="Copy" className="size-3.5" />
        </button>
      </div>
      <div ref={outer} className={cn("max-h-[28rem] min-w-0 overflow-auto", SMOOTH_HEIGHT_CLASS)}>
        <div
          ref={inner}
          role="tree"
          aria-label={label ?? "JSON"}
          className="flex min-w-0 flex-col py-1 font-mono text-[12px] leading-5"
        >
          {rows.length === 0 ? (
            <p className="m-0 px-3 py-1.5 font-sans text-xs text-muted-foreground">{rootKind === "array" ? "An empty list." : "An empty object."}</p>
          ) : null}
          {rows.map((row, index) => {
            const container = row.type === "value" && row.children > 0;
            const rowOpen = container && isOpen(row.id);
            const onClick = (event: MouseEvent) => {
              setFocused(row.id);
              // A click that ends a text selection selects; it doesn't copy.
              if (window.getSelection()?.toString()) return;
              event.preventDefault();
              activate(row);
            };
            return (
              <div
                key={row.id}
                ref={(element) => {
                  if (element === null) rowRefs.current.delete(row.id);
                  else rowRefs.current.set(row.id, element);
                }}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-setsize={row.type === "value" ? row.siblings : undefined}
                aria-posinset={row.type === "value" ? row.position : undefined}
                aria-expanded={container ? rowOpen : undefined}
                aria-keyshortcuts={row.type === "value" ? "C P" : undefined}
                aria-description={row.type === "value" ? (container ? "C copies it, P copies its path" : "Enter or C copies it, P copies its path") : undefined}
                tabIndex={row.id === tabStop ? 0 : -1}
                onFocus={() => setFocused(row.id)}
                onClick={onClick}
                onKeyDown={(event) => onKeyDown(event, index)}
                className={cn(
                  "group relative flex min-h-6 min-w-0 shrink-0 cursor-pointer items-start gap-1 pr-1.5 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
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
                <span aria-hidden className="flex h-6 w-3.5 shrink-0 items-center justify-center text-muted-foreground">
                  {container ? (
                    <Icon
                      name="ChevronRight"
                      aria-hidden
                      className={cn("size-3 transition-transform duration-150 motion-reduce:transition-none", rowOpen && "rotate-90")}
                    />
                  ) : null}
                </span>
                {row.type === "more" ? (
                  <span className="py-0.5 font-sans text-xs text-muted-foreground group-hover:text-foreground">
                    Show {formatNumber(Math.min(row.remaining, CHILD_PAGE))} more of {formatNumber(row.remaining)}
                  </span>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 py-0.5 [overflow-wrap:anywhere]">
                      {row.key === null ? null : typeof row.key === "number" ? (
                        <span className="mr-1.5 text-muted-foreground">{row.key}</span>
                      ) : (
                        <span className="text-foreground">
                          {row.key}
                          <span className="mr-1.5 text-muted-foreground">:</span>
                        </span>
                      )}
                      {isContainer(row.kind) ? (
                        <ContainerSummary value={row.value} kind={row.kind} open={rowOpen} />
                      ) : (
                        <ScalarText value={row.value} kind={row.kind} full={fullStrings.has(row.id)} onToggle={() => toggleString(row.id)} />
                      )}
                    </span>
                    <span
                      className={cn(
                        "flex h-6 shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:group-focus:opacity-100",
                        row.id === focused && "[@media(hover:none)]:opacity-100",
                      )}
                    >
                      <button
                        type="button"
                        tabIndex={-1}
                        title={isContainer(row.kind) ? "Copy as JSON" : "Copy value"}
                        onClick={(event) => {
                          event.stopPropagation();
                          copy(copyText(row.value));
                        }}
                        className={ROW_ACTION}
                      >
                        <Icon name="Copy" aria-hidden className="size-3" />
                        Copy
                      </button>
                      <button
                        type="button"
                        tabIndex={-1}
                        title={`Copy path ${row.id}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          copy(row.id);
                        }}
                        className={cn(ROW_ACTION, "font-mono")}
                      >
                        $.path
                      </button>
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
