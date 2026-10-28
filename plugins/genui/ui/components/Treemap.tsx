// Sizes as a squarified treemap: where the bytes of a bundle, a disk or a
// budget go. Two levels at a time, each top-level group in its own colour
// with its name strip, the biggest tiles labelled with name, size and share;
// a group zooms in on click and a breadcrumb leads back. The list view (a
// toggle, and always the screen-reader version) has the same level sorted by
// size.
import { useCallback, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { formatAmount, formatShare } from "../../core/perf-units";
import { findNode, GROUP_HEADER, layoutTreemap, readTreemap, trail, type Tile, type TreeNode } from "../../core/treemap";
import { ACCENT, optionalText, type Props } from "../values";
import { ErrorLine } from "./display";
import { FOCUS_RING } from "./inputs";
import { RISE, useEntrance } from "./motion";
import { Frame, Heading, Quiet, Segmented, TEXT_BUTTON } from "./perfKit";

/** List rows shown before "Show N more". */
const LIST_PAGE = 50;

type View = "map" | "list";

const VIEWS = [
  { value: "map", label: "Map" },
  { value: "list", label: "List" },
] as const;

export function Treemap({ props }: { props: Props }) {
  const unit = optionalText(props.unit);
  const read = useMemo(() => readTreemap(props.items, unit), [props.items, unit]);
  if (!read.ok) return <ErrorLine message={read.error} />;
  return (
    <Frame label="Treemap">
      <TreemapView root={read.treemap.root} unit={read.treemap.unit} ignored={read.treemap.ignored} />
    </Frame>
  );
}

/**
 * Group colours, largest group first: the accent, then hues far apart from it
 * and each other. Groups past these share a neutral grey, so the biggest
 * groups stay telling apart instead of every colour repeating pale.
 */
const GROUP_COLORS = [
  ACCENT,
  "var(--success)",
  "var(--warning)",
  "var(--attention)",
  "color-mix(in oklab, var(--color-timeline-accent, var(--primary)) 50%, var(--success))",
  "color-mix(in oklab, var(--warning) 45%, var(--destructive))",
] as const;

/**
 * A group's colour mixed into the page so labels stay readable. Mixed in
 * oklab, not oklch: a hue mixed with white in oklch drifts (blue turns lilac,
 * green peach) where the page's white has no hue.
 */
function tint(group: number, amount: number): string {
  const color = group < GROUP_COLORS.length ? GROUP_COLORS[group] : "var(--muted-foreground)";
  return `color-mix(in oklab, ${color} ${group < GROUP_COLORS.length ? amount : Math.round(amount * 0.6)}%, var(--background))`;
}

function TreemapView({ root, unit, ignored }: { root: TreeNode; unit: string | null; ignored: number }) {
  const [view, setView] = useState<View>("map");
  const [zoom, setZoom] = useState(root.path);
  const [picked, setPicked] = useState<string | null>(null);
  // A path that left the data (the spec changed) falls back to the root.
  const current = findNode(root, zoom) ?? root;
  const crumbs = trail(root, current.path);
  const go = (path: string) => {
    setZoom(path);
    setPicked(null);
  };
  if (root.value <= 0) return <Quiet>Nothing to show{ignored > 0 ? ` (${ignored} items without a name or a positive size)` : ""}.</Quiet>;
  const pickedNode = picked === null ? null : findNode(root, picked);
  return (
    <>
      <Heading
        title={
          <nav aria-label="Treemap level" className="flex min-w-0 flex-wrap items-baseline gap-x-1">
            {crumbs.map((node, index) => {
              const last = index === crumbs.length - 1;
              const name = node.name === "" ? "All" : node.name;
              return (
                <span key={node.path} className="inline-flex min-w-0 items-baseline gap-x-1">
                  {last ? (
                    <span aria-current="location" className="truncate">
                      {name}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => go(node.path)}
                      className={cn("cursor-pointer truncate rounded-sm font-normal text-muted-foreground hover:text-foreground", FOCUS_RING)}
                    >
                      {name}
                    </button>
                  )}
                  {last ? null : (
                    <span aria-hidden className="font-normal text-muted-foreground">
                      ›
                    </span>
                  )}
                </span>
              );
            })}
          </nav>
        }
        meta={[
          formatAmount(current.value, unit),
          current === root ? null : `${formatShare(current.value, root.value)} of ${root.name === "" ? "all" : root.name}`,
          `${current.children.length} ${current.children.length === 1 ? "item" : "items"}`,
          ignored > 0 ? `${ignored} unreadable left out` : null,
        ]
          .filter((part) => part !== null)
          .join(" · ")}
        aside={<Segmented label="View" value={view} options={VIEWS} onChange={setView} />}
      />
      {view === "map" ? (
        <>
          <MapView node={current} total={current.value} unit={unit} onZoom={go} onPick={setPicked} picked={picked} />
          <p aria-live="polite" className="m-0 h-5 truncate text-xs leading-5 text-muted-foreground">
            {pickedNode !== null ? (
              <>
                <span className="font-medium text-foreground">{pickedNode.path.split("/").slice(crumbs.length - 1).join("/") || pickedNode.name}</span>
                {` · ${formatAmount(pickedNode.value, unit)} · ${formatShare(pickedNode.value, current.value)}`}
              </>
            ) : current.children.some((child) => child.children.length > 0) ? (
              "Click a group to zoom in; the list view has every item."
            ) : (
              "The list view has every item, largest first."
            )}
          </p>
          <div className="sr-only">
            <ListView node={current} unit={unit} onZoom={go} />
          </div>
        </>
      ) : (
        <ListView node={current} unit={unit} onZoom={go} />
      )}
    </>
  );
}

/**
 * A callback ref and the element's content box, kept current by a
 * ResizeObserver; 0 × 0 until measured. The map's height comes from CSS
 * (container queries), so it is read, never set.
 */
function useBox<T extends HTMLElement>(): [(element: T | null) => () => void, { width: number; height: number }] {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const ref = useCallback((element: T | null) => {
    if (element === null) return () => {};
    setBox({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect !== undefined) setBox((previous) => (previous.width === rect.width && previous.height === rect.height ? previous : { width: rect.width, height: rect.height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, box];
}

function MapView({
  node,
  total,
  unit,
  onZoom,
  onPick,
  picked,
}: {
  node: TreeNode;
  total: number;
  unit: string | null;
  onZoom: (path: string) => void;
  onPick: (path: string | null) => void;
  picked: string | null;
}) {
  const [ref, { width, height }] = useBox<HTMLDivElement>();
  const rise = useEntrance<HTMLDivElement>(RISE);
  const layout = useMemo(() => (width > 0 && height > 0 ? layoutTreemap(node, width, height) : { tiles: [] }), [node, width, height]);
  return (
    // The map is the sighted view; the list beside it is what assistive tech reads.
    <div ref={rise} aria-hidden className="min-w-0">
      <div ref={ref} className="relative h-64 w-full min-w-0 select-none overflow-hidden rounded-lg @md:h-80">
        {layout.tiles.map((tile) => (
          <TileView key={tile.node.path} tile={tile} total={total} unit={unit} onZoom={onZoom} onPick={onPick} picked={picked === tile.node.path} />
        ))}
      </div>
    </div>
  );
}

function TileView({
  tile,
  total,
  unit,
  onZoom,
  onPick,
  picked,
}: {
  tile: Tile;
  total: number;
  unit: string | null;
  onZoom: (path: string) => void;
  onPick: (path: string | null) => void;
  picked: boolean;
}) {
  const { node, level, group, folded } = tile;
  const holder = level === 1 && node.children.length > 0 && folded === 0 && tile.w >= 64 && tile.h >= 48;
  const zoomable = node.children.length > 0 && folded === 0;
  const showName = tile.w >= 40 && tile.h >= 16;
  const showSize = tile.w >= 56 && (holder ? false : tile.h >= 34);
  const size = `${formatAmount(node.value, unit)} · ${formatShare(node.value, total)}`;
  return (
    <div
      onClick={(event) => {
        event.stopPropagation();
        if (zoomable) onZoom(node.path);
        else onPick(picked ? null : node.path);
      }}
      title={`${node.name} · ${size}${zoomable ? " · click to zoom in" : ""}`}
      className={cn(
        "absolute overflow-hidden rounded-[3px] transition-[filter] duration-150 hover:brightness-[0.96] dark:hover:brightness-[1.12]",
        zoomable || folded === 0 ? "cursor-pointer" : "cursor-default",
        picked && "ring-2 ring-inset ring-foreground/70",
      )}
      style={{
        left: tile.x + 1,
        top: tile.y + 1,
        width: Math.max(0, tile.w - 2),
        height: Math.max(0, tile.h - 2),
        background: holder ? tint(group, 14) : folded > 0 ? tint(group, level === 1 ? 10 : 18) : tint(group, level === 1 ? 34 : 30),
      }}
    >
      {showName ? (
        <div className={cn("flex min-w-0 flex-col px-1.5", holder ? "h-[18px] justify-center" : "pt-1")} style={holder ? { height: GROUP_HEADER } : undefined}>
          <span className={cn("truncate text-[11px] leading-4 text-foreground", (level === 1 || zoomable) && "font-medium", folded > 0 && "text-muted-foreground")}>
            {node.name}
            {holder ? <span className="font-normal text-muted-foreground"> · {size}</span> : null}
          </span>
          {showSize ? <span className="truncate text-[10.5px] leading-4 tabular-nums text-muted-foreground">{size}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function ListView({ node, unit, onZoom }: { node: TreeNode; unit: string | null; onZoom: (path: string) => void }) {
  const [shown, setShown] = useState(LIST_PAGE);
  const largest = node.children[0]?.value ?? 0;
  const rest = node.children.length - shown;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <ol aria-label={`${node.name === "" ? "All" : node.name}, by size`} className="m-0 flex min-w-0 list-none flex-col p-0">
        {node.children.slice(0, shown).map((child, index) => {
          const share = formatShare(child.value, node.value);
          const amount = formatAmount(child.value, unit);
          const name = (
            <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground" title={child.path}>
              {child.name}
              {child.package ? <span className="ml-1.5 text-[10.5px] text-muted-foreground">package</span> : null}
            </span>
          );
          return (
            <li key={child.path} className="flex min-w-0 flex-col gap-0.5 border-b border-border/50 py-1.5 last:border-b-0">
              <div className="flex min-w-0 items-center gap-2">
                <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: tint(index, 70) }} />
                {child.children.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => onZoom(child.path)}
                    aria-label={`${child.name}: ${amount}, ${share}. Open its ${child.children.length} items`}
                    className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm text-left hover:underline", FOCUS_RING)}
                  >
                    {name}
                    <span aria-hidden className="shrink-0 text-xs text-muted-foreground">
                      ›
                    </span>
                  </button>
                ) : (
                  name
                )}
                <span className="shrink-0 text-xs tabular-nums text-foreground">{amount}</span>
                <span className="w-11 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{share}</span>
              </div>
              <div aria-hidden className="ml-4 h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full" style={{ width: `${largest > 0 ? (child.value / largest) * 100 : 0}%`, background: tint(index, 70) }} />
              </div>
            </li>
          );
        })}
      </ol>
      {rest > 0 ? (
        <button type="button" onClick={() => setShown((count) => count + LIST_PAGE)} className={TEXT_BUTTON}>
          Show {Math.min(rest, LIST_PAGE)} more of {rest}
        </button>
      ) : null}
    </div>
  );
}
