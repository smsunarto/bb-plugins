// Hand-written responsive SVG charts, drawn in pixel space (measured with a
// ResizeObserver) so text never scales. Geometry is set both as an attribute
// and as the CSS `d` property, so engines that animate `d` ease between
// values when the UI's state changes and the rest snap. On first mount lines
// draw themselves, areas fade in, bars grow from the baseline and donuts sweep
// round. The arithmetic (stacking, slices, rounding) lives in chartMath.ts,
// the shared drawing pieces in chartKit.tsx, and the scatter, radar, funnel,
// heatmap, histogram and box types in chartTypes.tsx.
import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import { finiteNumber, list, optionalText, text, tone, type Props } from "../values";
import {
  barPath,
  CHAR_WIDTH,
  ChartPath,
  COMPACT_FORMAT,
  DRAW,
  EASE,
  formatValue,
  GROW,
  GROW_STAGGER_STEPS,
  Marker,
  mouseLeave,
  NO_DATA,
  readSeries,
  SeriesLegend,
  sliceColor,
  TONE_STROKE,
  TOOLTIP,
  useWidth,
  withUnit,
  type Series,
} from "./chartKit";
import { niceStep, percentages, pieSlices, stackSeries, trendLabel, type Segment } from "./chartMath";
import { BoxChart, FunnelChart, HeatmapChart, HistogramChart, RadarChart, ScatterChart } from "./chartTypes";
import { CHART_DRAW_MS, FADE, type Entrance } from "./motion";

const PLOT_HEIGHT = 168;
const PAD_TOP = 8;
const PAD_BOTTOM = 22;
const PAD_RIGHT = 4;
/** Minimum horizontal room per shown x label; denser labels are skipped. */
const MIN_LABEL_SPACING = 48;
const MAX_BAR_WIDTH = 28;
const AREA: Entrance = { keyframes: FADE.keyframes, duration: CHART_DRAW_MS };

type Point = readonly [number, number];

/**
 * Monotone cubic interpolation (Fritsch–Carlson): a smooth line that never
 * overshoots its data, so a peak drawn is a peak measured.
 */
function smoothPath(points: readonly Point[]): string {
  if (points.length < 3) return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
  const slopes = points.slice(1).map(([x, y], i) => (y - points[i]![1]) / (x - points[i]![0]));
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0]!;
    if (i === points.length - 1) return slopes[i - 1]!;
    const before = slopes[i - 1]!;
    const after = slopes[i]!;
    return before * after <= 0 ? 0 : (2 * before * after) / (before + after);
  });
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    const third = (x1 - x0) / 3;
    d += ` C${x0 + third},${y0 + tangents[i - 1]! * third} ${x1 - third},${y1 - tangents[i]! * third} ${x1},${y1}`;
  }
  return d;
}

/** Points from the top, clockwise; `from`/`to` in radians. A whole turn is two half arcs. */
function arcPath(c: number, r: number, from: number, to: number): string {
  const at = (angle: number) => `${c + r * Math.sin(angle)},${c - r * Math.cos(angle)}`;
  if (to - from >= Math.PI * 2 - 1e-6) {
    return `M${at(0)} A${r},${r} 0 1 1 ${at(Math.PI)} A${r},${r} 0 1 1 ${at(0)}`;
  }
  return `M${at(from)} A${r},${r} 0 ${to - from > Math.PI ? 1 : 0} 1 ${at(to)}`;
}

const CHART_TYPES = ["bar", "line", "area", "pie", "scatter", "radar", "funnel", "heatmap", "histogram", "box"] as const;
type ChartType = (typeof CHART_TYPES)[number];

export function Chart({ props }: { props: Props }) {
  const type: ChartType = CHART_TYPES.find((name) => name === props.type) ?? "bar";
  const labels = list(props.labels).map(text);
  const series = readSeries(props.series);
  const unit = optionalText(props.unit);
  switch (type) {
    case "pie":
      // A donut has one ring: the first series; any others are ignored.
      return <Donut labels={labels} values={series[0]?.values ?? []} unit={unit} />;
    case "funnel":
      // So does a funnel.
      return <FunnelChart labels={labels} values={series[0]?.values ?? []} unit={unit} />;
    case "scatter":
      return <ScatterChart labels={labels} series={series} unit={unit} />;
    case "radar":
      return <RadarChart labels={labels} series={series} unit={unit} />;
    case "heatmap":
      return <HeatmapChart labels={labels} series={series} unit={unit} />;
    case "histogram":
      return <HistogramChart labels={labels} series={series} unit={unit} />;
    case "box":
      return <BoxChart labels={labels} series={series} unit={unit} />;
    default: {
      // Stacking only means something for piles: bars and areas with several series.
      const stacked = props.stacked === true && type !== "line" && series.length > 1;
      return <XYChart type={type} labels={labels} series={series} unit={unit} stacked={stacked} />;
    }
  }
}

function XYChart({
  type,
  labels,
  series,
  unit,
  stacked,
}: {
  type: "bar" | "line" | "area";
  labels: string[];
  series: Series[];
  unit: string | null;
  stacked: boolean;
}) {
  const [frame, width] = useWidth<HTMLDivElement>();
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const count = Math.max(labels.length, ...series.map((entry) => entry.values.length));
  const segments: (Segment | null)[][] | null = stacked ? stackSeries(series.map((entry) => entry.values)) : null;
  /** Where series `seriesIndex` is drawn at `index`: its value, or its stack's top. */
  const top = (seriesIndex: number, index: number): number | null =>
    segments === null
      ? (series[seriesIndex]?.values[index] ?? null)
      : (segments[seriesIndex]?.[index]?.to ?? null);
  const values =
    segments === null
      ? series.flatMap((entry) => entry.values).filter((value) => value !== null)
      : segments.flat().flatMap((segment) => (segment === null ? [] : [segment.to]));

  if (count === 0 || values.length === 0) return NO_DATA;

  // Bars and areas always stand on zero; a line keeps zero unless its data sits far above it.
  const dataHigh = Math.max(...values);
  const dataLow = Math.min(...values);
  const keepZero = type !== "line" || dataLow <= 0 || dataLow < dataHigh * 0.5;
  const span = (keepZero ? Math.max(dataHigh, 0) - Math.min(dataLow, 0) : dataHigh - dataLow) || Math.abs(dataHigh) || 1;
  const step = niceStep(span / 4);
  const ceiling = Math.ceil((keepZero ? Math.max(dataHigh, 0) : dataHigh) / step) * step || step;
  const bottom = Math.floor((keepZero ? Math.min(dataLow, 0) : dataLow) / step) * step;
  const ticks = Array.from({ length: Math.round((ceiling - bottom) / step) + 1 }, (_, i) => bottom + i * step);
  const tickLabels = ticks.map((tick) => withUnit(COMPACT_FORMAT.format(tick), unit));

  const padLeft = Math.max(...tickLabels.map((label) => label.length)) * CHAR_WIDTH + 10;
  const plotWidth = Math.max(1, width - padLeft - PAD_RIGHT);
  const height = PAD_TOP + PLOT_HEIGHT + PAD_BOTTOM;
  const y = (value: number) => PAD_TOP + ((ceiling - value) / (ceiling - bottom)) * PLOT_HEIGHT;
  const zero = y(Math.min(Math.max(0, bottom), ceiling));
  const band = plotWidth / count;
  const center = (index: number) => padLeft + band * (index + 0.5);
  const labelEvery = Math.max(1, Math.ceil(MIN_LABEL_SPACING / band));
  const labelChars = Math.max(3, Math.floor((band * labelEvery) / CHAR_WIDTH) - 1);

  // Side-by-side bars share a group; stacked bars are one column per label.
  const columns = stacked ? 1 : series.length;
  const gap = columns > 1 ? 3 : 0;
  const groupWidth = Math.min(band * 0.72, MAX_BAR_WIDTH * columns + gap * (columns - 1));
  const barWidth = (groupWidth - gap * (columns - 1)) / columns;

  const tooltipX = hover === null ? 0 : center(hover);
  const hoverTotal =
    hover === null || !stacked
      ? null
      : series.reduce<number | null>((sum, entry) => {
          const value = entry.values[hover] ?? null;
          return value === null ? sum : (sum ?? 0) + value;
        }, null);
  const summary = labels
    .map((label, index) =>
      [label, ...series.map((entry) => {
        const value = entry.values[index] ?? null;
        return value === null ? "" : `${entry.name || "value"} ${formatValue(value, unit)}`;
      })]
        .filter(Boolean)
        .join(" "),
    )
    .join("; ");

  const bar = (seriesIndex: number, index: number, color: string) => {
    const value = series[seriesIndex]?.values[index] ?? null;
    if (value === null) return null;
    let d: string;
    if (segments === null) {
      const x = center(index) - groupWidth / 2 + seriesIndex * (barWidth + gap);
      d = barPath(x, barWidth, zero, y(value));
    } else {
      const segment = segments[seriesIndex]?.[index] ?? null;
      if (segment === null || segment.from === segment.to) return null;
      const to = y(segment.to);
      let from = y(segment.from);
      // A hairline of air between stacked pieces, when the piece is tall enough to spare it.
      if (segment.from !== 0 && Math.abs(to - from) > 2) from += to < from ? -1 : 1;
      d = barPath(center(index) - groupWidth / 2, groupWidth, from, to, segment.outer);
    }
    return (
      <ChartPath
        key={`${seriesIndex}:${index}`}
        d={d}
        fill={color}
        opacity={hover === null || hover === index ? 1 : 0.35}
        // Grows from the zero line, left to right; a stack grows as one.
        entrance={{ ...GROW, delay: Math.min(index, GROW_STAGGER_STEPS) * 40 }}
        style={{ transformBox: "view-box", transformOrigin: `0 ${zero}px` }}
      />
    );
  };

  const lines = series.map((entry, seriesIndex) => {
    // Gaps (null values) split the line into separate runs.
    const runs: number[][] = [[]];
    entry.values.forEach((value, index) => {
      if (value === null) runs.push([]);
      else runs[runs.length - 1]!.push(index);
    });
    return runs
      .filter((run) => run.length > 0)
      .map((run, runIndex) => {
        const upper: Point[] = run.map((index) => [center(index), y(top(seriesIndex, index)!)]);
        const line = smoothPath(upper);
        let area: string | null = null;
        if (type === "area" && run.length > 1) {
          if (segments === null) {
            area = `${line} L${upper[upper.length - 1]![0]},${zero} L${upper[0]![0]},${zero} Z`;
          } else {
            // A band between this series' stack top and the stack under it.
            const lower: Point[] = run
              .map((index): Point => [center(index), y(segments[seriesIndex]![index]!.from)])
              .reverse();
            area = `${line} L${smoothPath(lower).slice(1)} Z`;
          }
        }
        return (
          <g key={`${seriesIndex}:${runIndex}`}>
            {area === null ? null : segments === null ? (
              <ChartPath d={area} fill={`url(#${gradientId}-${seriesIndex})`} entrance={AREA} />
            ) : (
              <ChartPath d={area} fill={entry.color} fillOpacity={0.22} entrance={AREA} />
            )}
            <ChartPath
              d={line}
              pathLength={1}
              fill="none"
              stroke={entry.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              entrance={DRAW}
            />
          </g>
        );
      });
  });

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <SeriesLegend series={series} swatch={type === "line" ? "line" : "square"} />
      <div
        ref={frame}
        className="relative w-full min-w-0"
        style={{ height }}
        onPointerLeave={mouseLeave(() => setHover(null))}
      >
        {width === 0 ? null : (
          <svg width={width} height={height} role="img" aria-label={summary} className="block overflow-visible">
            {type === "area" && segments === null ? (
              <defs>
                {series.map((entry, seriesIndex) => (
                  <linearGradient key={seriesIndex} id={`${gradientId}-${seriesIndex}`} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={entry.color} stopOpacity={0.16} />
                    <stop offset="100%" stopColor={entry.color} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
            ) : null}
            {ticks.map((tick, index) => (
              <g key={tick}>
                <line
                  x1={padLeft}
                  x2={width - PAD_RIGHT}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke="var(--border)"
                  strokeOpacity={tick === 0 ? 1 : 0.55}
                  strokeDasharray={tick === 0 ? undefined : "2 3"}
                />
                <text
                  x={padLeft - 10}
                  y={y(tick)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-muted-foreground text-[10.5px] tabular-nums"
                >
                  {tickLabels[index]}
                </text>
              </g>
            ))}
            {labels.map((label, index) =>
              index % labelEvery === 0 ? (
                <text
                  key={index}
                  x={center(index)}
                  y={height - 6}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10.5px] tabular-nums"
                >
                  {label.length > labelChars ? `${label.slice(0, labelChars - 1)}…` : label}
                </text>
              ) : null,
            )}

            {type === "bar"
              ? series.map((entry, seriesIndex) => entry.values.map((_, index) => bar(seriesIndex, index, entry.color)))
              : lines}

            {type !== "bar" && hover !== null ? (
              <line
                x1={tooltipX}
                x2={tooltipX}
                y1={PAD_TOP}
                y2={PAD_TOP + PLOT_HEIGHT}
                stroke="var(--muted-foreground)"
                strokeOpacity={0.35}
              />
            ) : null}
            {type !== "bar"
              ? series.map((entry, seriesIndex) => {
                  // The latest point stays marked; hovering marks the hovered one.
                  const index = hover ?? entry.values.reduce<number>((last, value, i) => (value === null ? last : i), -1);
                  const value = top(seriesIndex, index);
                  if (value === null) return null;
                  return (
                    <Marker
                      key={seriesIndex}
                      cx={center(index)}
                      cy={y(value)}
                      r={3.5}
                      fill={entry.color}
                      stroke="var(--background)"
                      strokeWidth={2}
                    />
                  );
                })
              : null}

            {/* Hover targets: one transparent column per label. */}
            {Array.from({ length: count }, (_, index) => (
              <rect
                key={index}
                x={padLeft + band * index}
                y={PAD_TOP}
                width={band}
                height={PLOT_HEIGHT}
                fill="transparent"
                onPointerEnter={() => setHover(index)}
              />
            ))}
          </svg>
        )}
        {hover === null ? null : (
          <div
            role="status"
            className={cn(TOOLTIP, "top-0")}
            style={
              tooltipX > width / 2
                ? { right: width - tooltipX + 10 }
                : { left: tooltipX + 10 }
            }
          >
            <div className="mb-1 font-medium text-foreground">{labels[hover] ?? ""}</div>
            {series.map((entry) => {
              const value = entry.values[hover] ?? null;
              return (
                <div key={entry.name} className="flex items-center justify-between gap-3 leading-5">
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <span aria-hidden className="size-2 rounded-[2px]" style={{ background: entry.color }} />
                    {entry.name || "Value"}
                  </span>
                  <span className="font-medium tabular-nums text-foreground">
                    {value === null ? "—" : formatValue(value, unit)}
                  </span>
                </div>
              );
            })}
            {hoverTotal === null ? null : (
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1 leading-5">
                <span className="text-muted-foreground">Total</span>
                <span className="font-medium tabular-nums text-foreground">{formatValue(hoverTotal, unit)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const DONUT_SIZE = 148;
const DONUT_THICKNESS = 20;
/** Air between donut slices, in pixels along the ring. */
const SLICE_GAP = 2;
/** "Other" reads as the remainder: quieter than any series color. */
const OTHER_COLOR = "color-mix(in oklch, var(--muted-foreground) 28%, var(--background))";

function Donut({ labels, values, unit }: { labels: string[]; values: (number | null)[]; unit: string | null }) {
  const maskId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const slices = pieSlices(labels, values);
  if (slices.length === 0) return NO_DATA;

  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const shares = percentages(slices.map((slice) => slice.value));
  const colors = slices.map((slice, position) => (slice.source === -1 ? OTHER_COLOR : sliceColor(position)));
  const center = DONUT_SIZE / 2;
  const radius = (DONUT_SIZE - DONUT_THICKNESS) / 2;
  let start = 0;
  const arcs = slices.map((slice) => {
    const sweep = (slice.value / total) * Math.PI * 2;
    // A slice thinner than the gap keeps a sliver rather than vanishing.
    const pad = slices.length > 1 ? Math.min(SLICE_GAP / radius, sweep / 3) / 2 : 0;
    const d = arcPath(center, radius, start + pad, start + sweep - pad);
    start += sweep;
    return d;
  });

  const shown = hover === null ? null : slices[hover] ?? null;
  const fullText = formatValue(shown?.value ?? total, unit);
  // The hole fits about eight characters at this size; longer totals go compact.
  const centerText =
    fullText.length <= 8 ? fullText : withUnit(COMPACT_FORMAT.format(shown?.value ?? total), unit);
  const share = (index: number) => (shares[index] === 0 ? "<1%" : `${shares[index]}%`);
  const summary = `Total ${formatValue(total, unit)}: ${slices
    .map((slice, index) => `${slice.label} ${formatValue(slice.value, unit)} (${share(index)})`)
    .join(", ")}`;

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-4"
      onPointerLeave={mouseLeave(() => setHover(null))}
    >
      <div className="relative shrink-0" style={{ width: DONUT_SIZE, height: DONUT_SIZE }} role="img" aria-label={summary}>
        <svg width={DONUT_SIZE} height={DONUT_SIZE} aria-hidden className="block">
          {/* A stroke drawn round the ring reveals it, so the slices sweep in clockwise. */}
          <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={DONUT_SIZE} height={DONUT_SIZE}>
            <ChartPath
              d={arcPath(center, radius, 0, Math.PI * 2)}
              pathLength={1}
              fill="none"
              stroke="white"
              strokeWidth={DONUT_THICKNESS + 4}
              entrance={DRAW}
            />
          </mask>
          <g mask={`url(#${maskId})`}>
            {arcs.map((d, index) => (
              <path
                key={slices[index]!.source}
                d={d}
                fill="none"
                stroke={colors[index]}
                strokeWidth={DONUT_THICKNESS}
                opacity={hover === null || hover === index ? 1 : 0.35}
                style={{ ...EASE, d: `path("${d}")` }}
                onPointerEnter={() => setHover(index)}
              />
            ))}
          </g>
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-base font-semibold leading-6 tabular-nums text-foreground">{centerText}</span>
          <span className="max-w-[84px] truncate text-[11px] leading-4 text-muted-foreground">
            {shown === null ? "Total" : shown.label}
          </span>
        </div>
      </div>
      <ul className="flex min-w-[10rem] flex-1 flex-col text-xs">
        {slices.map((slice, index) => (
          <li
            key={slice.source}
            className={cn(
              "flex items-center gap-2 leading-6 transition-opacity duration-150",
              hover !== null && hover !== index && "opacity-50",
            )}
            onPointerEnter={() => setHover(index)}
          >
            <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: colors[index] }} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{slice.label}</span>
            <span className="font-medium tabular-nums text-foreground">{formatValue(slice.value, unit)}</span>
            <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">{share(index)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SPARK_WIDTH = 80;
const SPARK_HEIGHT = 20;
/** Room for the stroke and the end dot inside the box. */
const SPARK_PAD = 2.5;

/** A word-sized trend line: the shape of `values`, the latest one dotted. */
export function Sparkline({ props }: { props: Props }) {
  const values = list(props.values).flatMap((value) => {
    const number = finiteNumber(value);
    return number === null ? [] : [number];
  });
  if (values.length < 2) return null;
  const color = TONE_STROKE[tone(props.tone)];
  const high = Math.max(...values);
  const low = Math.min(...values);
  const x = (index: number) => SPARK_PAD + (index * (SPARK_WIDTH - SPARK_PAD * 2)) / (values.length - 1);
  const y = (value: number) =>
    high === low ? SPARK_HEIGHT / 2 : SPARK_PAD + ((high - value) / (high - low)) * (SPARK_HEIGHT - SPARK_PAD * 2);
  const points = values.map((value, index): Point => [x(index), y(value)]);
  const [lastX, lastY] = points[points.length - 1]!;
  return (
    <svg
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      role="img"
      aria-label={trendLabel(values)}
      className="inline-block shrink-0 overflow-visible align-middle"
    >
      <ChartPath
        d={smoothPath(points)}
        pathLength={1}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        entrance={DRAW}
      />
      <Marker cx={lastX} cy={lastY} r={2.25} fill={color} />
    </svg>
  );
}
