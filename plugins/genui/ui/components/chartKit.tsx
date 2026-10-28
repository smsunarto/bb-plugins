// What every chart shares: the series palette, value formatting, paths that
// ease between geometries and draw in once, width measuring, the legend and
// the floating readout. Chart.tsx, chartTypes.tsx, meters.tsx and
// CalendarHeatmap.tsx draw with these so they look and move alike.
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type SVGProps,
} from "react";
import { cn } from "@/lib/utils";
import { ACCENT, finiteNumber, formatNumber, isObject, tone, type Tone } from "../values";
import type { Value } from "../../core/types";
import { CHART_DRAW_MS, EASE_OUT_EXPO, FADE, useEntrance, type Entrance } from "./motion";

/** Series colors in order: the accent, its quiet counterpart, then the tones. */
export const PALETTE = [
  ACCENT,
  "color-mix(in oklch, var(--muted-foreground) 55%, var(--background))",
  "var(--success)",
  "var(--warning)",
  "var(--destructive)",
  "var(--attention)",
] as const;

/** The palette, then softened palette colors past its end so neighbors never repeat. */
export function sliceColor(position: number): string {
  const color = PALETTE[position % PALETTE.length]!;
  return position < PALETTE.length ? color : `color-mix(in oklch, ${color} 50%, var(--background))`;
}

/** One drawn color per tone; neutral and info take the accent, like a chart's first series. */
export const TONE_STROKE: Record<Tone, string> = {
  neutral: ACCENT,
  info: ACCENT,
  good: "var(--success)",
  warn: "var(--warning)",
  bad: "var(--destructive)",
};

/** Approximate advance of one 10.5px tabular character. */
export const CHAR_WIDTH = 6.2;

/** Axis and tick text. */
export const AXIS_TEXT = "fill-muted-foreground text-[10.5px] tabular-nums";

export const EASE: CSSProperties = {
  transition: `d 420ms ${EASE_OUT_EXPO}, opacity 150ms ease-out`,
};

/** Strokes are measured as length 1 (`pathLength`), so the dash covers any line. */
export const DRAW: Entrance = {
  keyframes: [
    { strokeDasharray: "1 1", strokeDashoffset: 1 },
    { strokeDasharray: "1 1", strokeDashoffset: 0 },
  ],
  duration: CHART_DRAW_MS,
};

/** Bars grow out of their baseline; set `transformOrigin` at it. */
export const GROW: Entrance = {
  keyframes: [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }],
  duration: CHART_DRAW_MS,
};
/** Bars after this many grow together. */
export const GROW_STAGGER_STEPS = 10;

/** A bar with rounded top corners (bottom corners for negative bars); square when not `rounded`. */
export function barPath(x: number, width: number, from: number, to: number, rounded = true): string {
  const height = Math.abs(to - from);
  const r = rounded ? Math.min(3, width / 2, height) : 0;
  if (to <= from) {
    return `M${x},${from} V${to + r} Q${x},${to} ${x + r},${to} H${x + width - r} Q${x + width},${to} ${x + width},${to + r} V${from} Z`;
  }
  return `M${x},${from} V${to - r} Q${x},${to} ${x + r},${to} H${x + width - r} Q${x + width},${to} ${x + width},${to - r} V${from} Z`;
}

/** The latest-point marker appears once the line has nearly reached it. */
const MARKER: Entrance = { keyframes: FADE.keyframes, duration: 400, delay: 700 };

/** A path that eases between geometries and plays `entrance` once, when it mounts. */
export function ChartPath({
  d,
  entrance,
  style,
  ...rest
}: Omit<SVGProps<SVGPathElement>, "ref" | "d"> & { d: string; entrance: Entrance }) {
  const ref = useEntrance<SVGPathElement>(entrance);
  return <path ref={ref} d={d} style={{ ...EASE, d: `path("${d}")`, ...style }} {...rest} />;
}

export function Marker(props: Omit<SVGProps<SVGCircleElement>, "ref">) {
  const ref = useEntrance<SVGCircleElement>(MARKER);
  return <circle ref={ref} {...props} />;
}

const SWEEP: Entrance = {
  keyframes: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
  duration: CHART_DRAW_MS,
};

/** Reveals what it masks left to right, once: the sweep of grid charts. */
export function SweepMask({ id, width, height }: { id: string; width: number; height: number }) {
  const ref = useEntrance<SVGRectElement>(SWEEP);
  return (
    <mask id={id} maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
      <rect
        ref={ref}
        width={width}
        height={height}
        fill="white"
        style={{ transformBox: "view-box", transformOrigin: "0 0" }}
      />
    </mask>
  );
}

export const COMPACT_FORMAT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Currency symbols lead (`$5`); other units trail (`5%`, `5 ms`). */
export function withUnit(value: string, unit: string | null): string {
  if (unit === null || unit === "") return value;
  if (/^[$€£¥]$/.test(unit)) return `${unit}${value}`;
  return unit.length === 1 ? `${value}${unit}` : `${value} ${unit}`;
}

/** A value at full precision with its unit, for tooltips and legends. */
export function formatValue(value: number, unit: string | null): string {
  return withUnit(formatNumber(value), unit);
}

export interface Series {
  name: string;
  values: (number | null)[];
  color: string;
}

export function readSeries(value: unknown): Series[] {
  const entries: [string, unknown][] = Array.isArray(value)
    ? [["", value]]
    : isObject(value)
      ? Object.entries(value)
      : [];
  return entries.flatMap(([name, entry], index) => {
    const toned = isObject(entry) && Array.isArray(entry.values);
    const values = toned ? entry.values : entry;
    if (!Array.isArray(values)) return [];
    const color =
      toned && entry.tone !== undefined
        ? TONE_STROKE[tone(entry.tone as Value)]
        : PALETTE[index % PALETTE.length]!;
    return [{ name, values: values.map(finiteNumber), color }];
  });
}

/**
 * A callback ref and the element's content width, kept current by a
 * ResizeObserver; 0 until measured. A callback, not an object ref, so a frame
 * that mounts after the first render (data streaming in) is still measured.
 */
export function useWidth<T extends HTMLElement>(): [(element: T | null) => () => void, number] {
  const [width, setWidth] = useState(0);
  const ref = useCallback((element: T | null) => {
    if (element === null) return () => {};
    setWidth(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * A pointer-leave handler that clears only for a mouse: after a tap the
 * finger "leaves" at once, and the readout the tap opened must stay up.
 */
export function mouseLeave(clear: () => void): (event: PointerEvent) => void {
  return (event) => {
    if (event.pointerType === "mouse") clear();
  };
}

export const NO_DATA = <p className="text-xs text-muted-foreground">No data</p>;

/** Series names with their swatches, when there is more than one to tell apart. */
export function SeriesLegend({ series, swatch = "square" }: { series: readonly Series[]; swatch?: "square" | "line" | "dot" }) {
  if (series.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((entry) => (
        <span key={entry.name} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn(
              "shrink-0",
              swatch === "line" ? "h-0.5 w-3 rounded-full" : swatch === "dot" ? "size-2 rounded-full" : "size-2 rounded-[2px]",
            )}
            style={{ background: entry.color }}
          />
          {entry.name}
        </span>
      ))}
    </div>
  );
}

/** The floating readout's surface. */
export const TOOLTIP =
  "pointer-events-none absolute z-10 min-w-[7rem] rounded-md border border-border bg-background px-2.5 py-1.5 text-xs shadow-[0_4px_12px_rgb(0_0_0/0.08)]";

/**
 * A readout for something spanning `top`..`bottom` at `x` in a frame `width`
 * wide: above it when there is room, else below, and always inside the frame
 * horizontally. A live region, so keyboard and screen-reader users hear what
 * a pointer would show.
 */
export function ChartTooltip({
  x,
  top,
  bottom,
  width,
  children,
}: {
  x: number;
  top: number;
  bottom: number;
  width: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Centred on x, then pulled back inside the frame once its own width is known.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const own = element.offsetWidth;
    element.style.left = `${Math.min(Math.max(0, x - own / 2), Math.max(0, width - own))}px`;
  });
  const above = top > 64;
  return (
    <div
      ref={ref}
      role="status"
      className={TOOLTIP}
      style={above ? { left: x, top: top - 8, transform: "translateY(-100%)" } : { left: x, top: bottom + 8 }}
    >
      {children}
    </div>
  );
}

/** One line of a readout: swatch and name on the left, the value on the right. */
export function TooltipRow({ color, name, value }: { color?: string; name: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 leading-5">
      <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {color === undefined ? null : (
          <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: color }} />
        )}
        <span className="truncate">{name}</span>
      </span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

/** `text` cut to `chars`, with an ellipsis when it had to be. */
export function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, Math.max(1, chars - 1))}…` : text;
}
