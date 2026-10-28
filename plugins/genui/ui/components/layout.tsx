import { useContext, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { sameCaption, sourceCaption } from "../../core/source";
import type { UiNode } from "../../core/types";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { RenderNode, RenderNodes } from "../render";
import { CardDepthContext } from "../runtime";
import { finiteNumber, list, nodes, optionalText, text, type Props } from "../values";
import { RISE, SMOOTH_HEIGHT_CLASS, useEntrance, useSmoothHeight, type Entrance } from "./motion";
import { SourceLine } from "./source";

/** The frame enters at once; only its rows and items are staggered. */
const FRAME: Entrance = { ...RISE, stagger: false };

function CardTitle({ title, nested }: { title: string | null; nested: boolean }) {
  if (title === null || title === "") return null;
  return (
    <h3
      className={cn(
        "m-0 text-balance text-foreground",
        nested ? "text-sm font-medium leading-5" : "text-[15px] font-semibold leading-6 tracking-[-0.01em]",
      )}
    >
      {title}
    </h3>
  );
}

/**
 * The outermost Card is the UI's one framed surface. A Card inside it is a
 * flat recessed tile (option cards, grouped sections): never a box in a box.
 */
export function Card({ props }: { props: Props }) {
  const depth = useContext(CardDepthContext);
  const rise = useEntrance<HTMLElement>(FRAME);
  const { outer, inner } = useSmoothHeight<HTMLElement, HTMLDivElement>();
  const title = optionalText(props.title);
  const children = <RenderNodes nodes={nodes(props.children)} />;
  if (depth > 0) {
    return (
      <CardDepthContext value={depth + 1}>
        <section className="flex min-w-0 flex-1 flex-col gap-2.5 rounded-lg bg-surface-recessed px-3.5 py-3 text-sm text-foreground [&>[data-button-group]:last-child]:mt-auto">
          <CardTitle title={title} nested />
          {children}
        </section>
      </CardDepthContext>
    );
  }
  // The frame rises in once and glides to each new height as content streams in.
  return (
    <CardDepthContext value={depth + 1}>
      <section
        ref={(element) => {
          rise.current = element;
          outer.current = element;
        }}
        className={cn(
          "min-w-0 rounded-xl border border-border bg-background p-4 text-sm text-foreground sm:px-5",
          SMOOTH_HEIGHT_CLASS,
        )}
      >
        <div ref={inner} className="flex min-w-0 flex-col gap-4">
          <CardTitle title={title} nested={false} />
          {children}
        </div>
      </section>
    </CardDepthContext>
  );
}

/** Controls with a natural width keep it instead of stretching to a column. */
const INTRINSIC_WIDTH: Partial<Record<UiNode["type"], true>> = {
  Button: true,
  Badge: true,
  File: true,
  Icon: true,
  Toggle: true,
};

/** One cell of a Row: rises in with its siblings the first time it appears. */
function RowItem({ className, children }: { className: string; children: ReactNode }) {
  const ref = useEntrance<HTMLDivElement>(RISE);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

export function Row({ props }: { props: Props }) {
  const children = nodes(props.children);
  // A row of metrics is a stat strip: an even grid that reflows by width.
  if (children.length > 1 && children.every((child) => child.type === "Metric")) {
    // Metrics read from one file (or given one source) name it once, under the strip.
    const captions = children.map((child) => sourceCaption(child.props));
    const shared = captions[0] !== null && captions.every((caption) => sameCaption(caption, captions[0])) ? captions[0] : null;
    // One shape with or without the line, so the strip never remounts when it appears.
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-x-6 gap-y-4">
          {children.map((child) => (
            <RowItem key={child.key} className="min-w-0">
              <RenderNode node={child} captioned={shared === null} />
            </RowItem>
          ))}
        </div>
        {shared === null ? null : <SourceLine caption={shared} />}
      </div>
    );
  }
  // A row of buttons is one set of choices: grouped, it folds into a single
  // "sent" line once answered instead of one per button.
  if (children.length > 0 && children.every((child) => child.type === "Button")) {
    return <RenderNodes nodes={children} />;
  }
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-x-5 gap-y-4">
      {children.map((child) => (
        <RowItem
          key={child.key}
          className={
            INTRINSIC_WIDTH[child.type]
              ? "flex max-w-full flex-none flex-col"
              : "flex min-w-[10rem] flex-1 flex-col self-stretch"
          }
        >
          <RenderNode node={child} />
        </RowItem>
      ))}
    </div>
  );
}

export function Stack({ props }: { props: Props }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <RenderNodes nodes={nodes(props.children)} />
    </div>
  );
}

/** The grid's `gap-3`, which its column math subtracts. */
const TILE_GAP = "0.75rem";

/**
 * Tiles on an even grid. Without `columns` it fits as many ~10rem tiles as
 * the container holds; with `columns` it uses that many where they fit and
 * fewer on narrow containers (each column stays at least 8rem).
 */
export function Grid({ props }: { props: Props }) {
  const children = nodes(props.children);
  const requested = finiteNumber(props.columns);
  const columns = requested === null ? null : Math.min(6, Math.max(1, Math.round(requested)));
  if (children.length === 0) return null;
  const template =
    columns === null
      ? "repeat(auto-fit,minmax(min(10rem,100%),1fr))"
      : `repeat(auto-fill,minmax(max(min(8rem,100%),calc((100% - ${columns - 1} * ${TILE_GAP}) / ${columns})),1fr))`;
  return (
    <div className="grid min-w-0 gap-3" style={{ gridTemplateColumns: template }}>
      {children.map((child) => (
        // Cards stretch so a row of tiles shares one height.
        <RowItem key={child.key} className="flex min-w-0 flex-col [&>section]:flex-1">
          <RenderNode node={child} />
        </RowItem>
      ))}
    </div>
  );
}

/** A disclosure: closed unless `open`; its body mounts on first open and glides open and shut. */
export function Details({ props }: { props: Props }) {
  const id = useId();
  const requested = props.open === true;
  const [open, setOpen] = useState(requested);
  // A streamed or re-evaluated `open` wins over the last click.
  const [lastRequested, setLastRequested] = useState(requested);
  if (requested !== lastRequested) {
    setLastRequested(requested);
    setOpen(requested);
  }
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();
  return (
    <div ref={outer} className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}>
      <div ref={inner} className="flex min-w-0 flex-col">
        <button
          type="button"
          id={`${id}-summary`}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen((value) => !value)}
          className="group flex w-full min-w-0 cursor-pointer items-start gap-1.5 rounded-sm text-left text-sm font-medium leading-5 text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon
            name="ChevronRight"
            aria-hidden
            className={cn(
              "mt-[3px] size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <span className="min-w-0 flex-1 text-balance [overflow-wrap:anywhere]">{text(props.title)}</span>
        </button>
        <div
          id={`${id}-body`}
          role="region"
          aria-labelledby={`${id}-summary`}
          hidden={!open}
          className={cn("min-w-0 flex-col gap-3 pl-5 pt-3", open ? "flex" : "hidden")}
        >
          {mounted ? <RenderNodes nodes={nodes(props.children)} /> : null}
        </div>
      </div>
    </div>
  );
}

export function Divider() {
  return <hr className="m-0 h-px w-full shrink-0 border-0 bg-border" />;
}

/**
 * Underlined tabs over one panel per label. Every panel stays mounted (the
 * inactive ones hidden), so switching keeps their state and never replays
 * their entrance; the panel area glides between heights.
 */
export function Tabs({ props }: { props: Props }) {
  const id = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();
  const [selected, setSelected] = useState(0);
  const panels = nodes(props.children);
  const labels = list(props.labels).map(text);
  const count = Math.max(labels.length, panels.length);
  // A streaming spec can shrink the tab count for a moment.
  const active = Math.min(selected, count - 1);

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (active + step + count) % count;
    setSelected(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div
        role="tablist"
        onKeyDown={onKeyDown}
        className="flex min-w-0 gap-4 overflow-x-auto border-b border-border [scrollbar-width:none]"
      >
        {Array.from({ length: count }, (_, index) => (
          <button
            key={index}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${index}`}
            aria-selected={index === active}
            aria-controls={`${id}-panel-${index}`}
            tabIndex={index === active ? 0 : -1}
            onClick={() => setSelected(index)}
            className={cn(
              "-mb-px shrink-0 cursor-pointer whitespace-nowrap border-b-2 pb-2 text-[13px] transition-colors duration-150 focus-visible:outline-none focus-visible:text-foreground",
              index === active
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {labels[index] || `Tab ${index + 1}`}
          </button>
        ))}
      </div>
      <div ref={outer} className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}>
        <div ref={inner} className="min-w-0">
          {Array.from({ length: count }, (_, index) => (
            <div
              // Panels are positional, like their labels.
              key={index}
              role="tabpanel"
              id={`${id}-panel-${index}`}
              aria-labelledby={`${id}-tab-${index}`}
              hidden={index !== active}
              className={cn("min-w-0 flex-col gap-3", index === active ? "flex" : "hidden")}
            >
              {panels[index] === undefined ? null : <RenderNode node={panels[index]} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
