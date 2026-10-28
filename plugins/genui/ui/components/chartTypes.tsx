// The Chart types beyond bar/line/area/pie: scatter, radar, funnel, heatmap,
// and histogram and box for raw observations. Same pixel-space drawing,
// palette, readout and entrance motion as Chart.tsx; every value is reachable
// by pointer, tap and arrow keys, and a summary carries it to screen readers.
// Geometry lives in chartMath.ts, the statistics in core/distribution.ts.
import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { ACCENT, formatNumber } from "../values";
import { boxSummary, EDGES_ERROR, histogram, leftOutNote, readSample, type BoxSummary } from "../../core/distribution";
import {
  AXIS_TEXT,
  barPath,
  CHAR_WIDTH,
  ChartPath,
  ChartTooltip,
  clip,
  COMPACT_FORMAT,
  formatValue,
  GROW,
  GROW_STAGGER_STEPS,
  mouseLeave,
  NO_DATA,
  SeriesLegend,
  SweepMask,
  TooltipRow,
  useWidth,
  withUnit,
  type Series,
} from "./chartKit";
import {
  countTicks,
  formatShare,
  funnelStages,
  intensity,
  nearestPoint,
  niceScale,
  numericValue,
  radarPoint,
  scatterPoints,
  stepGrid,
  valueRange,
} from "./chartMath";
import { ErrorLine } from "./display";
import { FOCUS_RING } from "./inputs";
import { CHART_DRAW_MS, FADE, useEntrance, type Entrance } from "./motion";

const PAD_TOP = 8;
const PAD_BOTTOM = 22;
const PAD_RIGHT = 8;
/** A focusable plot: a quiet ring for keyboard focus only. */
const PLOT = cn("relative w-full min-w-0 rounded-sm", FOCUS_RING);

/** The pointer's position inside the element handling the event. */
function localPoint(event: PointerEvent<Element>): [number, number] {
  const box = event.currentTarget.getBoundingClientRect();
  return [event.clientX - box.left, event.clientY - box.top];
}

/** Arrow-key handling shared by the plots: Escape clears, other keys move or pass through. */
function handleKeys(
  event: KeyboardEvent,
  move: (key: string) => boolean,
  clear: () => void,
): void {
  if (event.key === "Escape") {
    clear();
    return;
  }
  if (move(event.key)) event.preventDefault();
}

// ——— Scatter ———

const SCATTER_HEIGHT = 200;
const DOT_RADIUS = 4.5;
/** How near (px) a pointer must come to a dot to read it; a finger gets more room. */
const REACH_MOUSE = 28;
const REACH_TOUCH = 40;

function Dot({ delay, ...props }: { delay: number; cx: number; cy: number; r: number; fill: string }) {
  const ref = useEntrance<SVGCircleElement>({
    keyframes: [
      { transform: "scale(0)", opacity: 0 },
      { transform: "scale(1)", opacity: 1 },
    ],
    duration: 700,
    delay,
  });
  return (
    <circle
      ref={ref}
      {...props}
      fillOpacity={0.85}
      stroke="var(--background)"
      strokeWidth={1.5}
      className="transition-[cx,cy] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
      style={{ transformBox: "fill-box", transformOrigin: "center", cx: props.cx, cy: props.cy }}
    />
  );
}

/** Labels are numeric x values; each series is the y values at them. */
export function ScatterChart({ labels, series, unit }: { labels: string[]; series: Series[]; unit: string | null }) {
  const [frame, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const xs = labels.map(numericValue);
  const points = scatterPoints(
    xs,
    series.map((entry) => entry.values),
  );
  if (points.length === 0) {
    return labels.length > 0 && xs.every((x) => x === null) ? (
      <ErrorLine message="A scatter chart's labels must be numbers: they are the x values" />
    ) : (
      NO_DATA
    );
  }

  const xRange = valueRange(points.map((point) => point.x))!;
  const yRange = valueRange(points.map((point) => point.y))!;
  const yScale = niceScale(yRange.min, yRange.max);
  const yLabels = yScale.ticks.map((tick) => withUnit(COMPACT_FORMAT.format(tick), unit));
  const padLeft = Math.max(...yLabels.map((label) => label.length)) * CHAR_WIDTH + 10;
  const plotWidth = Math.max(1, width - padLeft - PAD_RIGHT);
  const xScale = niceScale(xRange.min, xRange.max, Math.max(2, Math.min(6, Math.floor(plotWidth / 72))));
  const height = PAD_TOP + SCATTER_HEIGHT + PAD_BOTTOM;
  const px = (value: number) => padLeft + ((value - xScale.min) / (xScale.max - xScale.min)) * plotWidth;
  const py = (value: number) => PAD_TOP + ((yScale.max - value) / (yScale.max - yScale.min)) * SCATTER_HEIGHT;
  const screen = points.map((point): [number, number] => [px(point.x), py(point.y)]);
  const shown = active === null ? null : (points[active] ?? null);
  const named = series.some((entry) => entry.name !== "");

  const summary = `Scatter plot, ${points.length} points. ${series
    .map((entry, seriesIndex) => {
      const own = points.filter((point) => point.series === seriesIndex);
      if (own.length === 0) return "";
      const x = valueRange(own.map((point) => point.x))!;
      const y = valueRange(own.map((point) => point.y))!;
      return `${entry.name || "Values"}: x ${formatNumber(x.min)} to ${formatNumber(x.max)}, y ${formatValue(y.min, unit)} to ${formatValue(y.max, unit)}`;
    })
    .filter(Boolean)
    .join("; ")}. Arrow keys read each point.`;

  const probe = (event: PointerEvent<HTMLDivElement>) => {
    const [x, y] = localPoint(event);
    const reach = event.pointerType === "mouse" ? REACH_MOUSE : REACH_TOUCH;
    const found = nearestPoint(screen, x, y, reach);
    if (found !== null || event.pointerType === "mouse") setActive(found);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <SeriesLegend series={series} swatch="dot" />
      <div
        ref={frame}
        tabIndex={0}
        role="group"
        aria-label={summary}
        className={PLOT}
        style={{ height }}
        onPointerMove={probe}
        onPointerDown={probe}
        onPointerLeave={mouseLeave(() => setActive(null))}
        onBlur={() => setActive(null)}
        onKeyDown={(event) =>
          handleKeys(
            event,
            (key) => {
              const next = stepGrid(key, 0, active ?? (key === "ArrowLeft" || key === "End" ? points.length : -1), 1, points.length);
              if (next === null) return false;
              setActive(Math.min(points.length - 1, Math.max(0, next[1])));
              return true;
            },
            () => setActive(null),
          )
        }
      >
        {width === 0 ? null : (
          <svg width={width} height={height} aria-hidden className="block overflow-visible">
            {yScale.ticks.map((tick, index) => (
              <g key={`y${tick}`}>
                <line
                  x1={padLeft}
                  x2={width - PAD_RIGHT}
                  y1={py(tick)}
                  y2={py(tick)}
                  stroke="var(--border)"
                  strokeOpacity={index === 0 ? 1 : 0.55}
                  strokeDasharray={index === 0 ? undefined : "2 3"}
                />
                <text x={padLeft - 10} y={py(tick)} textAnchor="end" dominantBaseline="middle" className={AXIS_TEXT}>
                  {yLabels[index]}
                </text>
              </g>
            ))}
            {xScale.ticks.map((tick, index) => (
              <g key={`x${tick}`}>
                {index === 0 ? null : (
                  <line
                    x1={px(tick)}
                    x2={px(tick)}
                    y1={PAD_TOP}
                    y2={PAD_TOP + SCATTER_HEIGHT}
                    stroke="var(--border)"
                    strokeOpacity={0.4}
                    strokeDasharray="2 3"
                  />
                )}
                <text
                  x={px(tick)}
                  y={height - 6}
                  textAnchor={index === xScale.ticks.length - 1 ? "end" : "middle"}
                  className={AXIS_TEXT}
                >
                  {COMPACT_FORMAT.format(tick)}
                </text>
              </g>
            ))}
            {shown === null ? null : (
              <g stroke="var(--muted-foreground)" strokeOpacity={0.45} strokeDasharray="3 3">
                <line x1={padLeft} x2={screen[active!]![0]} y1={screen[active!]![1]} y2={screen[active!]![1]} />
                <line x1={screen[active!]![0]} x2={screen[active!]![0]} y1={screen[active!]![1]} y2={PAD_TOP + SCATTER_HEIGHT} />
              </g>
            )}
            {points.map((point, index) => (
              <Dot
                key={`${point.series}:${point.index}`}
                cx={screen[index]![0]}
                cy={screen[index]![1]}
                r={DOT_RADIUS}
                fill={series[point.series]!.color}
                // Dots arrive left to right, like a line drawing itself.
                delay={((point.x - xScale.min) / (xScale.max - xScale.min || 1)) * 900}
              />
            ))}
            {shown === null ? null : (
              <circle
                cx={screen[active!]![0]}
                cy={screen[active!]![1]}
                r={DOT_RADIUS + 3}
                fill="none"
                stroke={series[shown.series]!.color}
                strokeWidth={2}
              />
            )}
          </svg>
        )}
        {shown === null || width === 0 ? null : (
          <ChartTooltip
            x={screen[active!]![0]}
            top={screen[active!]![1] - DOT_RADIUS}
            bottom={screen[active!]![1] + DOT_RADIUS}
            width={width}
          >
            <div className="mb-1 font-medium text-foreground">x {formatNumber(shown.x)}</div>
            <TooltipRow
              color={named ? series[shown.series]!.color : undefined}
              name={series[shown.series]!.name || "y"}
              value={formatValue(shown.y, unit)}
            />
          </ChartTooltip>
        )}
      </div>
    </div>
  );
}

// ——— Radar ———

/** Polygons grow out of the centre. */
const RADAR_GROW: Entrance = {
  keyframes: [
    { transform: "scale(0)", opacity: 0 },
    { transform: "scale(1)", opacity: 1 },
  ],
  duration: CHART_DRAW_MS,
};
const RADAR_MAX_RADIUS = 130;
/** Room above the top axis label and below the bottom one. */
const RADAR_PAD_Y = 24;
const RADAR_LABEL_GAP = 10;

/** Labels are the axes (three or more), one polygon per series. */
export function RadarChart({ labels, series, unit }: { labels: string[]; series: Series[]; unit: string | null }) {
  const [frame, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const axes = labels.length;
  if (axes < 3) return <ErrorLine message="A radar chart needs at least 3 labels, one per axis" />;
  const range = valueRange(series.flatMap((entry) => entry.values.slice(0, axes)));
  if (range === null) return NO_DATA;

  const scale = niceScale(range.min, range.max, 4, true);
  const longest = Math.max(...labels.map((label) => label.length));
  const sideRoom = Math.min(longest * CHAR_WIDTH, width * 0.24) + RADAR_LABEL_GAP + 4;
  const radius = Math.max(36, Math.min((width - sideRoom * 2) / 2, RADAR_MAX_RADIUS));
  const height = radius * 2 + RADAR_PAD_Y * 2;
  const cx = width / 2;
  const cy = RADAR_PAD_Y + radius;
  const ratio = (value: number) => (value - scale.min) / (scale.max - scale.min);
  const ring = (fraction: number) =>
    `${labels.map((_, axis) => `${axis === 0 ? "M" : "L"}${radarPoint(cx, cy, radius, axis, axes, fraction).join(",")}`).join(" ")} Z`;
  // A missing value sits at the centre: it reads as nothing, not as a break in the shape.
  const at = (entry: Series, axis: number) => radarPoint(cx, cy, radius, axis, axes, ratio(entry.values[axis] ?? scale.min));

  const summary = `${labels
    .map((label, axis) =>
      [label, ...series.map((entry) => {
        const value = entry.values[axis] ?? null;
        return value === null ? "" : `${entry.name || "value"} ${formatValue(value, unit)}`;
      })]
        .filter(Boolean)
        .join(" "),
    )
    .join("; ")}. Arrow keys read each axis.`;

  const probe = (event: PointerEvent<HTMLDivElement>) => {
    const [x, y] = localPoint(event);
    const angle = Math.atan2(x - cx, cy - y);
    const turn = (angle + Math.PI * 2) % (Math.PI * 2);
    setActive(Math.round((turn / (Math.PI * 2)) * axes) % axes);
  };
  const labelAt = (axis: number) => {
    const angle = (axis / axes) * Math.PI * 2;
    const [x, y] = radarPoint(cx, cy, radius + RADAR_LABEL_GAP, axis, axes, 1);
    const side = Math.sin(angle);
    const vertical = Math.cos(angle);
    return {
      x,
      y,
      anchor: side > 0.2 ? "start" : side < -0.2 ? "end" : "middle",
      baseline: vertical > 0.2 ? "auto" : vertical < -0.2 ? "hanging" : "middle",
      chars: Math.max(3, Math.floor((Math.abs(side) > 0.2 ? sideRoom - RADAR_LABEL_GAP : width * 0.4) / CHAR_WIDTH)),
    } as const;
  };

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <SeriesLegend series={series} />
      <div
        ref={frame}
        tabIndex={0}
        role="group"
        aria-label={summary}
        className={PLOT}
        style={{ height }}
        onPointerMove={probe}
        onPointerDown={probe}
        onPointerLeave={mouseLeave(() => setActive(null))}
        onBlur={() => setActive(null)}
        onKeyDown={(event) =>
          handleKeys(
            event,
            (key) => {
              // Round the dial: right and down go clockwise, left and up back.
              const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
              if (step === 0 && key !== "Home" && key !== "End") return false;
              setActive(key === "Home" ? 0 : key === "End" ? axes - 1 : (((active ?? (step > 0 ? -1 : 0)) + step) % axes + axes) % axes);
              return true;
            },
            () => setActive(null),
          )
        }
      >
        {width === 0 ? null : (
          <svg width={width} height={height} aria-hidden className="block overflow-visible">
            {scale.ticks.slice(1).map((tick) => (
              <path
                key={tick}
                d={ring(ratio(tick))}
                fill="none"
                stroke="var(--border)"
                strokeOpacity={tick === scale.max ? 1 : 0.6}
                strokeDasharray={tick === scale.max ? undefined : "2 3"}
              />
            ))}
            {labels.map((_, axis) => {
              const [x, y] = radarPoint(cx, cy, radius, axis, axes, 1);
              return (
                <line
                  key={axis}
                  x1={cx}
                  y1={cy}
                  x2={x}
                  y2={y}
                  stroke={axis === active ? "var(--muted-foreground)" : "var(--border)"}
                  strokeOpacity={axis === active ? 0.6 : 0.8}
                />
              );
            })}
            {series.map((entry, seriesIndex) => (
              <ChartPath
                key={entry.name || seriesIndex}
                d={`${labels.map((_, axis) => `${axis === 0 ? "M" : "L"}${at(entry, axis).join(",")}`).join(" ")} Z`}
                fill={entry.color}
                fillOpacity={0.14}
                stroke={entry.color}
                strokeWidth={2}
                strokeLinejoin="round"
                entrance={{ ...RADAR_GROW, delay: seriesIndex * 120 }}
                style={{ transformBox: "view-box", transformOrigin: `${cx}px ${cy}px` }}
              />
            ))}
            {/* Over the shapes, haloed in the background color so lines never cross the numbers. */}
            {scale.ticks.slice(1).map((tick) => (
              <text
                key={`t${tick}`}
                x={cx + 4}
                y={radarPoint(cx, cy, radius, 0, axes, ratio(tick))[1]}
                dominantBaseline="hanging"
                stroke="var(--background)"
                strokeWidth={3}
                strokeLinejoin="round"
                paintOrder="stroke"
                className={cn(AXIS_TEXT, "text-[9.5px]")}
              >
                {withUnit(COMPACT_FORMAT.format(tick), unit)}
              </text>
            ))}
            {active === null
              ? null
              : series.map((entry, seriesIndex) => {
                  const [x, y] = at(entry, active);
                  return (
                    <circle
                      key={seriesIndex}
                      cx={x}
                      cy={y}
                      r={4}
                      fill={entry.color}
                      stroke="var(--background)"
                      strokeWidth={2}
                    />
                  );
                })}
            {labels.map((label, axis) => {
              const place = labelAt(axis);
              return (
                <text
                  key={axis}
                  x={place.x}
                  y={place.y}
                  textAnchor={place.anchor}
                  dominantBaseline={place.baseline}
                  className={cn(
                    "text-[11px]",
                    axis === active ? "fill-foreground font-medium" : "fill-muted-foreground",
                  )}
                >
                  {clip(label, place.chars)}
                </text>
              );
            })}
          </svg>
        )}
        {active === null || width === 0 ? null : (
          <ChartTooltip x={labelAt(active).x} top={labelAt(active).y - 14} bottom={labelAt(active).y + 14} width={width}>
            <div className="mb-1 font-medium text-foreground">{labels[active]}</div>
            {series.map((entry) => {
              const value = entry.values[active] ?? null;
              return (
                <TooltipRow
                  key={entry.name}
                  color={entry.color}
                  name={entry.name || "Value"}
                  value={value === null ? "—" : formatValue(value, unit)}
                />
              );
            })}
          </ChartTooltip>
        )}
      </div>
    </div>
  );
}

// ——— Funnel ———

const FUNNEL_STAGGER_MS = 90;

function FunnelBar({ width, color, index }: { width: number; color: string; index: number }) {
  const ref = useEntrance<HTMLDivElement>({
    keyframes: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
    duration: CHART_DRAW_MS,
    delay: index * FUNNEL_STAGGER_MS,
  });
  return (
    <div
      ref={ref}
      className="h-full min-w-[3px] rounded-[5px] transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
      style={{ width: `${width * 100}%`, background: color }}
    />
  );
}

/** The narrowing between two bars, with the step's conversion over it. */
function FunnelNeck({ from, to, share, index }: { from: number; to: number; share: string | null; index: number }) {
  const ref = useEntrance<HTMLDivElement>({ ...FADE, delay: index * FUNNEL_STAGGER_MS + 300 });
  const left = (fraction: number) => 50 - (fraction * 100) / 2;
  return (
    <div ref={ref} aria-hidden className="relative h-5">
      <svg viewBox="0 0 100 20" preserveAspectRatio="none" className="absolute inset-0 size-full">
        <polygon
          points={`${left(from)},0 ${100 - left(from)},0 ${100 - left(to)},20 ${left(to)},20`}
          fill={ACCENT}
          fillOpacity={0.1}
        />
      </svg>
      {share === null ? null : (
        <span className="absolute inset-0 flex items-center justify-center text-[11px] leading-none tabular-nums text-muted-foreground">
          ↓ {share}
        </span>
      )}
    </div>
  );
}

/** Labels are the stages, the first series their counts: bars narrowing by stage, conversion between them. */
export function FunnelChart({ labels, values, unit }: { labels: string[]; values: (number | null)[]; unit: string | null }) {
  const stages = funnelStages(labels, values);
  if (stages.length === 0) return NO_DATA;
  const last = stages.length - 1;
  // Deeper stages fade a little toward the background: the eye follows the drop. Mixed in
  // oklab, which keeps the hue; oklch would swing a blue toward violet on the way to white.
  const color = (index: number) =>
    `color-mix(in oklab, ${ACCENT} ${last === 0 ? 100 : Math.round(100 - (index / last) * 45)}%, var(--background))`;
  const first = stages[0]!.label;
  return (
    <ol className="m-0 flex min-w-0 list-none flex-col p-0">
      {stages.map((stage, index) => (
        <li key={index} className="flex flex-col">
          {index === 0 ? null : (
            <div className="grid grid-cols-[minmax(4.5rem,28%)_minmax(0,1fr)_minmax(4.5rem,auto)] gap-3">
              <span />
              <FunnelNeck
                from={stages[index - 1]!.width}
                to={stage.width}
                share={stage.ofPrevious === null ? null : formatShare(stage.ofPrevious)}
                index={index}
              />
              <span />
            </div>
          )}
          <div className="grid grid-cols-[minmax(4.5rem,28%)_minmax(0,1fr)_minmax(4.5rem,auto)] items-center gap-3">
            <span className="truncate text-xs leading-5 text-muted-foreground" title={stage.label}>
              {stage.label}
            </span>
            <div className="flex h-7 min-w-0 justify-center">
              <FunnelBar width={stage.width} color={color(index)} index={index} />
            </div>
            <span className="flex items-baseline justify-end gap-1.5 text-xs leading-5 tabular-nums">
              <span className="font-medium text-foreground">{formatValue(stage.value, unit)}</span>
              {index === 0 || stage.ofFirst === null ? null : (
                <span className="text-muted-foreground">{formatShare(stage.ofFirst)}</span>
              )}
            </span>
            {index === 0 ? null : (
              <span className="sr-only">
                {[
                  stage.ofFirst === null ? "" : `${formatShare(stage.ofFirst)} of ${first}`,
                  stage.ofPrevious === null ? "" : `${formatShare(stage.ofPrevious)} of the stage before`,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </span>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ——— Heatmap ———

const HEAT_MIN_ROW = 24;
const HEAT_MAX_ROW = 34;
/** Minimum horizontal room per shown column label; denser labels are skipped. */
const HEAT_LABEL_SPACING = 40;

/** The accent, from a faint wash at the lowest value to full at the highest. */
function heatColor(t: number): string {
  return `color-mix(in oklab, ${ACCENT} ${Math.round(10 + t * 90)}%, var(--background))`;
}

/** Labels are the columns, each series a row; one color scale across all cells. */
export function HeatmapChart({ labels, series, unit }: { labels: string[]; series: Series[]; unit: string | null }) {
  const [frame, width] = useWidth<HTMLDivElement>();
  const maskId = useId();
  const [active, setActive] = useState<readonly [number, number] | null>(null);
  const cols = Math.max(labels.length, ...series.map((entry) => entry.values.length));
  const range = valueRange(series.flatMap((entry) => entry.values));
  if (series.length === 0 || cols === 0 || range === null) return NO_DATA;

  const rows = series.length;
  const rowNames = series.map((entry, index) => entry.name || (rows > 1 ? `Row ${index + 1}` : ""));
  const longest = Math.max(...rowNames.map((name) => name.length));
  const padLeft = longest === 0 ? 0 : Math.min(longest * CHAR_WIDTH + 10, width * 0.3);
  const cellWidth = Math.max(1, (width - padLeft) / cols);
  const cellHeight = Math.min(HEAT_MAX_ROW, Math.max(HEAT_MIN_ROW, cellWidth * 0.7));
  const gridHeight = rows * cellHeight;
  const height = gridHeight + PAD_BOTTOM;
  const labelEvery = Math.max(1, Math.ceil(HEAT_LABEL_SPACING / cellWidth));
  const labelChars = Math.max(3, Math.floor((cellWidth * labelEvery) / CHAR_WIDTH) - 1);
  const rowChars = Math.max(3, Math.floor((padLeft - 10) / CHAR_WIDTH));
  const t = (value: number) => intensity(value, range.min, range.max);
  const value = (row: number, col: number) => series[row]?.values[col] ?? null;
  const columnName = (col: number) => labels[col] || `Column ${col + 1}`;

  const summary = `Heatmap, ${rows} rows by ${cols} columns, from ${formatValue(range.min, unit)} to ${formatValue(range.max, unit)}. ${series
    .map((entry, row) =>
      [rowNames[row], ...entry.values.map((cell, col) => (cell === null ? "" : `${columnName(col)} ${formatValue(cell, unit)}`))]
        .filter(Boolean)
        .join(" "),
    )
    .join("; ")}. Arrow keys read each cell.`;

  const probe = (event: PointerEvent<HTMLDivElement>) => {
    const [x, y] = localPoint(event);
    const col = Math.floor((x - padLeft) / cellWidth);
    const row = Math.floor(y / cellHeight);
    if (col >= 0 && col < cols && row >= 0 && row < rows) setActive([row, col]);
    else if (event.pointerType === "mouse") setActive(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        ref={frame}
        tabIndex={0}
        role="group"
        aria-label={summary}
        className={PLOT}
        style={{ height }}
        onPointerMove={probe}
        onPointerDown={probe}
        onPointerLeave={mouseLeave(() => setActive(null))}
        onBlur={() => setActive(null)}
        onKeyDown={(event) =>
          handleKeys(
            event,
            (key) => {
              const next = stepGrid(key, active?.[0] ?? 0, active?.[1] ?? 0, rows, cols);
              if (next === null) return false;
              // The first key press lands on the first cell rather than moving past it.
              setActive(active === null ? [0, 0] : next);
              return true;
            },
            () => setActive(null),
          )
        }
      >
        {width === 0 ? null : (
          <svg width={width} height={height} aria-hidden className="block overflow-visible">
            <defs>
              <SweepMask id={maskId} width={width} height={gridHeight} />
            </defs>
            {rowNames.map((name, row) =>
              name === "" ? null : (
                <text
                  key={row}
                  x={padLeft - 10}
                  y={row * cellHeight + cellHeight / 2}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className={cn("text-[11px]", active?.[0] === row ? "fill-foreground" : "fill-muted-foreground")}
                >
                  {clip(name, rowChars)}
                </text>
              ),
            )}
            <g mask={`url(#${maskId})`}>
              {series.map((_, row) =>
                Array.from({ length: cols }, (_, col) => {
                  const cell = value(row, col);
                  const x = padLeft + col * cellWidth;
                  const y = row * cellHeight;
                  const shade = cell === null ? 0 : t(cell);
                  const compact = cell === null ? "" : COMPACT_FORMAT.format(cell);
                  // Numbers print in the cell when they fit: values are read, not only seen as color.
                  const fits = cell !== null && compact.length * CHAR_WIDTH + 8 <= cellWidth - 2 && cellHeight >= 20;
                  return (
                    <g key={`${row}:${col}`}>
                      <rect
                        x={x + 1}
                        y={y + 1}
                        width={Math.max(0, cellWidth - 2)}
                        height={cellHeight - 2}
                        rx={3}
                        fill={cell === null ? "color-mix(in oklch, var(--muted-foreground) 7%, transparent)" : heatColor(shade)}
                        className="transition-[fill] duration-300 motion-reduce:transition-none"
                      />
                      {fits ? (
                        <text
                          x={x + cellWidth / 2}
                          y={y + cellHeight / 2}
                          textAnchor="middle"
                          dominantBaseline="central"
                          className="text-[10.5px] tabular-nums"
                          fill={shade > 0.55 ? "var(--background)" : "var(--foreground)"}
                        >
                          {compact}
                        </text>
                      ) : null}
                    </g>
                  );
                }),
              )}
            </g>
            {active === null ? null : (
              <rect
                x={padLeft + active[1] * cellWidth + 0.5}
                y={active[0] * cellHeight + 0.5}
                width={Math.max(0, cellWidth - 1)}
                height={cellHeight - 1}
                rx={3.5}
                fill="none"
                stroke="var(--foreground)"
                strokeWidth={1.5}
              />
            )}
            {Array.from({ length: cols }, (_, col) =>
              col % labelEvery === 0 ? (
                <text
                  key={col}
                  x={padLeft + col * cellWidth + cellWidth / 2}
                  y={height - 6}
                  textAnchor="middle"
                  className={cn(AXIS_TEXT, active?.[1] === col && "fill-foreground")}
                >
                  {clip(labels[col] ?? "", labelChars)}
                </text>
              ) : null,
            )}
          </svg>
        )}
        {active === null || width === 0 ? null : (
          <ChartTooltip
            x={padLeft + active[1] * cellWidth + cellWidth / 2}
            top={active[0] * cellHeight}
            bottom={(active[0] + 1) * cellHeight}
            width={width}
          >
            <div className="mb-1 font-medium text-foreground">{columnName(active[1])}</div>
            <TooltipRow
              color={value(active[0], active[1]) === null ? undefined : heatColor(t(value(active[0], active[1])!))}
              name={rowNames[active[0]] || "Value"}
              value={value(active[0], active[1]) === null ? "—" : formatValue(value(active[0], active[1])!, unit)}
            />
          </ChartTooltip>
        )}
      </div>
      <div aria-hidden className="flex items-center justify-end gap-2 text-[10.5px] tabular-nums text-muted-foreground">
        <span>{withUnit(COMPACT_FORMAT.format(range.min), unit)}</span>
        <span
          className="h-2 w-24 rounded-full"
          style={{ background: `linear-gradient(to right, ${heatColor(0)}, ${heatColor(1)})` }}
        />
        <span>{withUnit(COMPACT_FORMAT.format(range.max), unit)}</span>
      </div>
    </div>
  );
}

// ——— Distributions: histogram and box ———

/** An axis number: compact from ten thousand, else up to two decimals, so an edge like 0.25 reads exactly. */
function axisNumber(value: number, unit: string | null): string {
  return withUnit(Math.abs(value) >= 10_000 ? COMPACT_FORMAT.format(value) : formatNumber(value), unit);
}

/** What a distribution chart left out (empty values, values outside the bins), under it. */
function LeftOut({ note }: { note: string | null }) {
  return note === null ? null : <p className="text-[11px] text-muted-foreground">{note}</p>;
}

const HIST_HEIGHT = 168;
/** Air between neighbouring bins, and between groups inside a bin when they have room for it. */
const BIN_GAP = 1;

/**
 * Series are raw values, counted into bins every group shares: the labels'
 * edges, or automatic ones. Groups stand side by side in each bin.
 */
export function HistogramChart({ labels, series, unit }: { labels: string[]; series: Series[]; unit: string | null }) {
  const [frame, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const samples = series.map((entry) => readSample(entry.name, entry.values));
  const result = histogram(labels, samples.map((sample) => sample.values));
  if (result === null) return <ErrorLine message={EDGES_ERROR} />;
  const note = leftOutNote(
    samples.reduce((all, sample) => all + sample.dropped, 0),
    result.outside,
  );
  const { edges, counts } = result;
  const bins = edges.length - 1;
  const total = counts.flat().reduce((all, count) => all + count, 0);
  if (bins < 1 || total === 0) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        {NO_DATA}
        <LeftOut note={note} />
      </div>
    );
  }

  const ticks = countTicks(Math.max(...counts.flat()));
  const top = ticks[ticks.length - 1]!;
  const padLeft = Math.max(...ticks.map((tick) => formatNumber(tick).length)) * CHAR_WIDTH + 10;
  const plotWidth = Math.max(1, width - padLeft - PAD_RIGHT);
  const height = PAD_TOP + HIST_HEIGHT + PAD_BOTTOM;
  const base = PAD_TOP + HIST_HEIGHT;
  const px = (value: number) => padLeft + ((value - edges[0]!) / (edges[bins]! - edges[0]!)) * plotWidth;
  const py = (count: number) => PAD_TOP + (1 - count / top) * HIST_HEIGHT;
  const groups = samples.length;
  const named = groups > 1;
  const range = (bin: number) => `${formatNumber(edges[bin]!)}–${formatValue(edges[bin + 1]!, unit)}`;

  // Edge labels left to right, each only where it clears the one before. The
  // first is drawn from its edge and the last up to it, so they stay inside.
  const edgeLabels = edges.map((edge) => axisNumber(edge, unit));
  const shownEdges: number[] = [];
  let clearFrom = -Infinity;
  edges.forEach((edge, index) => {
    const labelWidth = edgeLabels[index]!.length * CHAR_WIDTH;
    const left = index === 0 ? px(edge) : index === bins ? px(edge) - labelWidth : px(edge) - labelWidth / 2;
    if (left < clearFrom) return;
    shownEdges.push(index);
    clearFrom = left + labelWidth + 8;
  });

  const summary = `Histogram of ${formatNumber(total)} ${total === 1 ? "value" : "values"} in ${bins} ${bins === 1 ? "bin" : "bins"} from ${formatNumber(edges[0]!)} to ${formatValue(edges[bins]!, unit)}. ${samples
    .map((sample, group) =>
      [
        named ? `${sample.name}:` : "",
        counts[group]!.flatMap((count, bin) => (count === 0 ? [] : [`${range(bin)} ${count}`])).join(", "),
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("; ")}. Arrow keys read each bin.`;

  const probe = (event: PointerEvent<HTMLDivElement>) => {
    const [x] = localPoint(event);
    const bin = edges.findIndex((edge, index) => index < bins && x >= px(edge) && x < px(edges[index + 1]!));
    if (bin >= 0) setActive(bin);
    else if (event.pointerType === "mouse") setActive(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <SeriesLegend series={series} />
      <div
        ref={frame}
        tabIndex={0}
        role="group"
        aria-label={summary}
        className={PLOT}
        style={{ height }}
        onPointerMove={probe}
        onPointerDown={probe}
        onPointerLeave={mouseLeave(() => setActive(null))}
        onBlur={() => setActive(null)}
        onKeyDown={(event) =>
          handleKeys(
            event,
            (key) => {
              const next = stepGrid(key, 0, active ?? 0, 1, bins);
              if (next === null) return false;
              // The first key press lands on the first bin rather than moving past it.
              setActive(active === null ? 0 : next[1]);
              return true;
            },
            () => setActive(null),
          )
        }
      >
        {width === 0 ? null : (
          <svg width={width} height={height} aria-hidden className="block overflow-visible">
            {ticks.map((tick, index) => (
              <g key={`y${tick}`}>
                <line
                  x1={padLeft}
                  x2={width - PAD_RIGHT}
                  y1={py(tick)}
                  y2={py(tick)}
                  stroke="var(--border)"
                  strokeOpacity={index === 0 ? 1 : 0.55}
                  strokeDasharray={index === 0 ? undefined : "2 3"}
                />
                <text x={padLeft - 10} y={py(tick)} textAnchor="end" dominantBaseline="middle" className={AXIS_TEXT}>
                  {formatNumber(tick)}
                </text>
              </g>
            ))}
            {shownEdges.map((index) => (
              <text
                key={`x${index}`}
                x={px(edges[index]!)}
                y={height - 6}
                textAnchor={index === 0 ? "start" : index === bins ? "end" : "middle"}
                className={AXIS_TEXT}
              >
                {edgeLabels[index]}
              </text>
            ))}
            {counts.map((own, group) =>
              own.map((count, bin) => {
                if (count === 0) return null;
                const from = px(edges[bin]!) + BIN_GAP / 2;
                const span = Math.max(1, px(edges[bin + 1]!) - BIN_GAP / 2 - from);
                const gap = groups > 1 && span / groups > 4 * BIN_GAP ? BIN_GAP : 0;
                const barWidth = (span - gap * (groups - 1)) / groups;
                return (
                  <ChartPath
                    key={`${group}:${bin}`}
                    d={barPath(from + group * (barWidth + gap), barWidth, base, py(count))}
                    fill={series[group]!.color}
                    opacity={active === null || active === bin ? 1 : 0.35}
                    // Grows from the baseline, left to right.
                    entrance={{ ...GROW, delay: Math.min(bin, GROW_STAGGER_STEPS) * 40 }}
                    style={{ transformBox: "view-box", transformOrigin: `0 ${base}px` }}
                  />
                );
              }),
            )}
          </svg>
        )}
        {active === null || active >= bins || width === 0 ? null : (
          <ChartTooltip
            x={(px(edges[active]!) + px(edges[active + 1]!)) / 2}
            top={py(Math.max(...counts.map((own) => own[active]!)))}
            bottom={base}
            width={width}
          >
            <div className="mb-1 font-medium text-foreground">{range(active)}</div>
            {samples.map((sample, group) => (
              <TooltipRow
                key={group}
                color={named ? series[group]!.color : undefined}
                name={named ? sample.name : "Count"}
                value={formatNumber(counts[group]![active]!)}
              />
            ))}
          </ChartTooltip>
        )}
      </div>
      <LeftOut note={note} />
    </div>
  );
}

const BOX_ROW = 36;
const BOX_HEIGHT = 14;
const WHISKER_CAP = 8;
const OUTLIER_RADIUS = 3;
/** Outliers a readout lists by value before it only counts them. */
const OUTLIERS_LISTED = 3;

/** A rectangle with rounded corners, as a path so it eases when the quartiles move. */
function roundedBox(x0: number, x1: number, top: number, bottom: number): string {
  const r = Math.min(3, (x1 - x0) / 2, (bottom - top) / 2);
  return `M${x0 + r},${top} H${x1 - r} Q${x1},${top} ${x1},${top + r} V${bottom - r} Q${x1},${bottom} ${x1 - r},${bottom} H${x0 + r} Q${x0},${bottom} ${x0},${bottom - r} V${top + r} Q${x0},${top} ${x0 + r},${top} Z`;
}

/**
 * One horizontal box per series of raw values (a single unnamed series takes
 * its name from the first label): the middle half as the box, the median as
 * a bar across it, whiskers to the furthest values within 1.5 IQR, outliers
 * as dots, and each group's n at the right.
 */
export function BoxChart({ labels, series, unit }: { labels: string[]; series: Series[]; unit: string | null }) {
  const [frame, width] = useWidth<HTMLDivElement>();
  const maskId = useId();
  const [active, setActive] = useState<number | null>(null);
  const samples = series.map((entry) => readSample(series.length === 1 && entry.name === "" ? (labels[0] ?? "") : entry.name, entry.values));
  const boxes = samples.map((sample) => boxSummary(sample.values));
  const note = leftOutNote(
    samples.reduce((all, sample) => all + sample.dropped, 0),
    0,
  );
  const present = boxes.filter((box): box is BoxSummary => box !== null);
  if (present.length === 0) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        {NO_DATA}
        <LeftOut note={note} />
      </div>
    );
  }

  const rows = samples.length;
  const longest = Math.max(...samples.map((sample) => sample.name.length));
  const padLeft = longest === 0 ? PAD_RIGHT : Math.min(longest * CHAR_WIDTH + 10, width * 0.35);
  const rowChars = Math.max(3, Math.floor((padLeft - 10) / CHAR_WIDTH));
  const counts = boxes.map((box) => `n=${formatNumber(box?.n ?? 0)}`);
  // Room for the n labels, clear of an outlier dot at the plot's right end.
  const padRight = Math.max(...counts.map((count) => count.length)) * CHAR_WIDTH + 16;
  const plotWidth = Math.max(1, width - padLeft - padRight);
  const scale = niceScale(
    Math.min(...present.map((box) => box.min)),
    Math.max(...present.map((box) => box.max)),
    Math.max(2, Math.min(6, Math.floor(plotWidth / 72))),
  );
  const plotHeight = rows * BOX_ROW;
  const height = plotHeight + PAD_BOTTOM;
  const px = (value: number) => padLeft + ((value - scale.min) / (scale.max - scale.min)) * plotWidth;
  const cy = (row: number) => row * BOX_ROW + BOX_ROW / 2;
  const shown = active === null ? null : (boxes[active] ?? null);

  const summary = `Box plot, ${rows} ${rows === 1 ? "group" : "groups"}. ${samples
    .map((sample, row) => {
      const box = boxes[row];
      const name = sample.name || "Values";
      if (box === null || box === undefined) return `${name}: no values`;
      return `${name}: n ${box.n}, median ${formatValue(box.median, unit)}, middle half ${formatNumber(box.q1)} to ${formatValue(box.q3, unit)}, whiskers ${formatNumber(box.low)} to ${formatValue(box.high, unit)}, ${box.outliers.length} ${box.outliers.length === 1 ? "outlier" : "outliers"}`;
    })
    .join("; ")}. Arrow keys read each group.`;

  const probe = (event: PointerEvent<HTMLDivElement>) => {
    const [, y] = localPoint(event);
    const row = Math.floor(y / BOX_ROW);
    if (row >= 0 && row < rows) setActive(row);
    else if (event.pointerType === "mouse") setActive(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div
        ref={frame}
        tabIndex={0}
        role="group"
        aria-label={summary}
        className={PLOT}
        style={{ height }}
        onPointerMove={probe}
        onPointerDown={probe}
        onPointerLeave={mouseLeave(() => setActive(null))}
        onBlur={() => setActive(null)}
        onKeyDown={(event) =>
          handleKeys(
            event,
            (key) => {
              const next = stepGrid(key, active ?? 0, 0, rows, 1);
              if (next === null) return false;
              // The first key press lands on the first group rather than moving past it.
              setActive(active === null ? 0 : next[0]);
              return true;
            },
            () => setActive(null),
          )
        }
      >
        {width === 0 ? null : (
          <svg width={width} height={height} aria-hidden className="block overflow-visible">
            <defs>
              <SweepMask id={maskId} width={width} height={plotHeight} />
            </defs>
            {scale.ticks.map((tick, index) => (
              <g key={tick}>
                <line
                  x1={px(tick)}
                  x2={px(tick)}
                  y1={0}
                  y2={plotHeight}
                  stroke="var(--border)"
                  strokeOpacity={index === 0 ? 1 : 0.55}
                  strokeDasharray={index === 0 ? undefined : "2 3"}
                />
                <text
                  x={px(tick)}
                  y={height - 6}
                  textAnchor={index === scale.ticks.length - 1 ? "end" : "middle"}
                  className={AXIS_TEXT}
                >
                  {axisNumber(tick, unit)}
                </text>
              </g>
            ))}
            {samples.map((sample, row) => (
              <g key={row}>
                {sample.name === "" ? null : (
                  <text
                    x={padLeft - 10}
                    y={cy(row)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className={cn("text-[11px]", active === row ? "fill-foreground" : "fill-muted-foreground")}
                  >
                    {clip(sample.name, rowChars)}
                  </text>
                )}
                <text x={width} y={cy(row)} textAnchor="end" dominantBaseline="middle" className={AXIS_TEXT}>
                  {counts[row]}
                </text>
              </g>
            ))}
            <g mask={`url(#${maskId})`}>
              {boxes.map((box, row) => {
                if (box === null) return null;
                const color = series[row]!.color;
                const y = cy(row);
                const top = y - BOX_HEIGHT / 2;
                const bottom = y + BOX_HEIGHT / 2;
                const caps = `M${px(box.low)},${y - WHISKER_CAP / 2} V${y + WHISKER_CAP / 2} M${px(box.high)},${y - WHISKER_CAP / 2} V${y + WHISKER_CAP / 2}`;
                return (
                  <g
                    key={row}
                    opacity={active === null || active === row ? 1 : 0.35}
                    className="transition-opacity duration-150 motion-reduce:transition-none"
                  >
                    <ChartPath
                      d={`M${px(box.low)},${y} H${px(box.q1)} M${px(box.q3)},${y} H${px(box.high)} ${caps}`}
                      fill="none"
                      stroke={color}
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      entrance={FADE}
                    />
                    <ChartPath
                      d={roundedBox(px(box.q1), Math.max(px(box.q3), px(box.q1) + 1), top, bottom)}
                      fill={color}
                      fillOpacity={0.18}
                      stroke={color}
                      strokeWidth={1.5}
                      entrance={FADE}
                    />
                    <ChartPath
                      d={`M${px(box.median)},${top} V${bottom}`}
                      fill="none"
                      stroke={color}
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      entrance={FADE}
                    />
                    {box.outliers.map((value, index) => (
                      <circle
                        key={index}
                        cx={px(value)}
                        cy={y}
                        r={OUTLIER_RADIUS}
                        fill="var(--background)"
                        stroke={color}
                        strokeWidth={1.5}
                      />
                    ))}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
        {shown === null || active === null || width === 0 ? null : (
          <ChartTooltip x={px(shown.median)} top={cy(active) - BOX_HEIGHT / 2} bottom={cy(active) + BOX_HEIGHT / 2} width={width}>
            <div className="mb-1 font-medium text-foreground">{samples[active]!.name || "Values"}</div>
            <TooltipRow name="n" value={formatNumber(shown.n)} />
            <TooltipRow name="Min" value={formatValue(shown.min, unit)} />
            <TooltipRow name="Q1" value={formatValue(shown.q1, unit)} />
            <TooltipRow name="Median" value={formatValue(shown.median, unit)} />
            <TooltipRow name="Q3" value={formatValue(shown.q3, unit)} />
            <TooltipRow name="Max" value={formatValue(shown.max, unit)} />
            {shown.outliers.length === 0 ? null : (
              <TooltipRow
                name={`${shown.outliers.length} ${shown.outliers.length === 1 ? "outlier" : "outliers"}`}
                value={`${shown.outliers
                  .slice(0, OUTLIERS_LISTED)
                  .map((value) => formatValue(value, unit))
                  .join(", ")}${shown.outliers.length > OUTLIERS_LISTED ? ", …" : ""}`}
              />
            )}
          </ChartTooltip>
        )}
      </div>
      <LeftOut note={note} />
    </div>
  );
}
