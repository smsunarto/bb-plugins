import { createContext, useContext, useMemo } from "react";
import type { ReactElement, ReactNode } from "react";
import { experimental_useCodeTheme as useCodeTheme } from "@get-bb/plugin-sdk/app";
import type { Tone } from "../shared/registry.ts";
import { derivePalette, withAlpha } from "./theme.ts";
import type { Palette } from "./theme.ts";
import { keyed } from "./keys.ts";

const PaletteContext = createContext<Palette | null>(null);

export function PaletteProvider(props: { readonly children: ReactNode }): ReactElement {
  const state = useCodeTheme();
  const palette = useMemo(() => derivePalette(state), [state]);
  return <PaletteContext.Provider value={palette}>{props.children}</PaletteContext.Provider>;
}

export function usePalette(): Palette {
  const palette = useContext(PaletteContext);
  return palette ?? derivePalette({ mode: "light", name: "fallback", theme: null });
}

export interface Series {
  readonly name: string;
  readonly data: readonly number[];
  readonly tone?: Tone;
}

export interface ReferenceLine {
  readonly value: number;
  readonly label?: string;
  readonly tone?: Tone;
}

export interface CartesianProps {
  readonly categories: readonly string[];
  readonly series: readonly Series[];
  readonly stacked?: boolean;
  readonly horizontal?: boolean;
  readonly referenceLines?: readonly ReferenceLine[];
  readonly title?: string;
  readonly caption?: string;
  readonly xAxisLabel?: string;
  readonly yAxisLabel?: string;
  readonly height?: number;
  readonly beginAtZero?: boolean;
  readonly yMin?: number;
  readonly yMax?: number;
}

const viewWidth = 640;
const margin = { top: 12, right: 16, bottom: 28, left: 52 };
const axisLabelSpace = 16;

function seriesColor(palette: Palette, series: Series, index: number): string {
  if (series.tone !== undefined) return palette.tone[series.tone];
  return palette.series[index % palette.series.length] ?? palette.accent;
}

function niceStep(range: number, ticks: number): number {
  const rough = range / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const factor = residual >= 5 ? 10 : residual >= 2 ? 5 : residual >= 1 ? 2 : 1;
  return factor * magnitude;
}

interface Scale {
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly number[];
}

function valueScale(props: CartesianProps, stackedTotals: readonly number[] | null): Scale {
  const values: number[] = [];
  if (stackedTotals === null) {
    for (const series of props.series) values.push(...series.data);
  } else {
    values.push(...stackedTotals, 0);
  }
  for (const line of props.referenceLines ?? []) values.push(line.value);
  let dataMin = Math.min(...values);
  let dataMax = Math.max(...values);
  if (!Number.isFinite(dataMin)) dataMin = 0;
  if (!Number.isFinite(dataMax)) dataMax = 0;
  if (props.beginAtZero !== false) dataMin = Math.min(0, dataMin);
  if (dataMin === dataMax) dataMax = dataMin + 1;
  const step = niceStep(dataMax - dataMin, 4);
  const min = props.yMin ?? Math.floor(dataMin / step) * step;
  const max = props.yMax ?? Math.ceil(dataMax / step) * step;
  const ticks: number[] = [];
  for (let tick = min; tick <= max + step / 2; tick += step) {
    ticks.push(Number(tick.toFixed(10)));
  }
  return { min, max: max > min ? max : min + step, ticks };
}

function formatNumber(value: number): string {
  if (Math.abs(value) >= 1000) return value.toLocaleString();
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function ChartFrame(props: {
  readonly title?: string;
  readonly caption?: string;
  readonly legend: readonly { name: string; color: string }[];
  readonly children: ReactNode;
}): ReactElement {
  return (
    <figure className="my-3 flex flex-col gap-2">
      {props.title !== undefined ? (
        <figcaption className="text-sm font-medium text-foreground">{props.title}</figcaption>
      ) : null}
      {props.children}
      {props.legend.length > 1 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {props.legend.map((entry) => (
            <li key={entry.name} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block size-2.5 rounded-sm"
                style={{ backgroundColor: entry.color }}
              />
              {entry.name}
            </li>
          ))}
        </ul>
      ) : null}
      {props.caption !== undefined ? (
        <p className="text-xs text-muted-foreground">{props.caption}</p>
      ) : null}
    </figure>
  );
}

interface Plot {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function plotArea(props: CartesianProps): { plot: Plot; total: number } {
  const total = props.height ?? 240;
  const left = margin.left + (props.yAxisLabel === undefined ? 0 : axisLabelSpace);
  const bottom = margin.bottom + (props.xAxisLabel === undefined ? 0 : axisLabelSpace);
  return {
    plot: {
      left,
      top: margin.top,
      width: viewWidth - left - margin.right,
      height: total - margin.top - bottom,
    },
    total,
  };
}

function Axes(props: {
  readonly plot: Plot;
  readonly scale: Scale;
  readonly categories: readonly string[];
  readonly horizontal: boolean;
  readonly xAxisLabel?: string;
  readonly yAxisLabel?: string;
  readonly total: number;
}): ReactElement {
  const palette = usePalette();
  const { plot, scale, horizontal } = props;
  const ratio = (value: number) => (value - scale.min) / (scale.max - scale.min);
  const band = horizontal
    ? plot.height / props.categories.length
    : plot.width / props.categories.length;
  const textClass = "fill-current text-muted-foreground";
  return (
    <g fontSize={10} className={textClass}>
      {scale.ticks.map((tick) => {
        const r = ratio(tick);
        return horizontal ? (
          <g key={tick}>
            <line
              x1={plot.left + r * plot.width}
              x2={plot.left + r * plot.width}
              y1={plot.top}
              y2={plot.top + plot.height}
              stroke={palette.stroke}
            />
            <text
              x={plot.left + r * plot.width}
              y={plot.top + plot.height + 12}
              textAnchor="middle"
            >
              {formatNumber(tick)}
            </text>
          </g>
        ) : (
          <g key={tick}>
            <line
              x1={plot.left}
              x2={plot.left + plot.width}
              y1={plot.top + (1 - r) * plot.height}
              y2={plot.top + (1 - r) * plot.height}
              stroke={palette.stroke}
            />
            <text x={plot.left - 6} y={plot.top + (1 - r) * plot.height + 3} textAnchor="end">
              {formatNumber(tick)}
            </text>
          </g>
        );
      })}
      {keyed(props.categories, (c) => c).map(({ key, item: category }, index) =>
        horizontal ? (
          <text
            key={key}
            x={plot.left - 6}
            y={plot.top + band * (index + 0.5) + 3}
            textAnchor="end"
          >
            {category}
          </text>
        ) : (
          <text
            key={key}
            x={plot.left + band * (index + 0.5)}
            y={plot.top + plot.height + 12}
            textAnchor="middle"
          >
            {category}
          </text>
        ),
      )}
      {props.xAxisLabel !== undefined ? (
        <text x={plot.left + plot.width / 2} y={props.total - 4} textAnchor="middle">
          {props.xAxisLabel}
        </text>
      ) : null}
      {props.yAxisLabel !== undefined ? (
        <text
          transform={`translate(10 ${plot.top + plot.height / 2}) rotate(-90)`}
          textAnchor="middle"
        >
          {props.yAxisLabel}
        </text>
      ) : null}
    </g>
  );
}

function ReferenceLines(props: {
  readonly plot: Plot;
  readonly scale: Scale;
  readonly lines: readonly ReferenceLine[];
  readonly horizontal: boolean;
}): ReactElement {
  const palette = usePalette();
  const { plot, scale } = props;
  return (
    <g fontSize={10}>
      {keyed(props.lines, (line) => `${line.value}:${line.label ?? ""}`).map(
        ({ key, item: line }) => {
          const r = (line.value - scale.min) / (scale.max - scale.min);
          const color = line.tone === undefined ? palette.tone.neutral : palette.tone[line.tone];
          if (props.horizontal) {
            const x = plot.left + r * plot.width;
            return (
              <g key={key}>
                <line
                  x1={x}
                  x2={x}
                  y1={plot.top}
                  y2={plot.top + plot.height}
                  stroke={color}
                  strokeDasharray="4 3"
                />
                {line.label !== undefined ? (
                  <text x={x + 4} y={plot.top + 10} fill={color}>
                    {line.label}
                  </text>
                ) : null}
              </g>
            );
          }
          const y = plot.top + (1 - r) * plot.height;
          return (
            <g key={key}>
              <line
                x1={plot.left}
                x2={plot.left + plot.width}
                y1={y}
                y2={y}
                stroke={color}
                strokeDasharray="4 3"
              />
              {line.label !== undefined ? (
                <text x={plot.left + plot.width - 4} y={y - 4} textAnchor="end" fill={color}>
                  {line.label}
                </text>
              ) : null}
            </g>
          );
        },
      )}
    </g>
  );
}

export function BarChart(props: CartesianProps): ReactElement {
  const palette = usePalette();
  const horizontal = props.horizontal === true;
  const stacked = props.stacked === true;
  const totals = stacked
    ? props.categories.map((_, index) =>
        props.series.reduce((sum, series) => sum + Math.max(0, series.data[index] ?? 0), 0),
      )
    : null;
  const scale = valueScale(props, totals);
  const { plot, total } = plotArea(props);
  const ratio = (value: number) =>
    Math.min(1, Math.max(0, (value - scale.min) / (scale.max - scale.min)));
  const zero = ratio(0);
  const bandSize = horizontal
    ? plot.height / props.categories.length
    : plot.width / props.categories.length;
  const groupSize = bandSize * 0.7;
  const barSize = stacked ? groupSize : groupSize / props.series.length;
  const legend = props.series.map((series, index) => ({
    name: series.name,
    color: seriesColor(palette, series, index),
  }));

  const bars: ReactElement[] = [];
  props.categories.forEach((category, categoryIndex) => {
    let offset = zero;
    props.series.forEach((series, seriesIndex) => {
      const value = series.data[categoryIndex] ?? 0;
      const color = seriesColor(palette, series, seriesIndex);
      const start = stacked ? offset : zero;
      const end = stacked ? offset + (ratio(value) - zero) : ratio(value);
      if (stacked) offset = end;
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      const along =
        bandSize * categoryIndex +
        (bandSize - groupSize) / 2 +
        (stacked ? 0 : barSize * seriesIndex);
      const key = `${category}-${series.name}`;
      const label = `${series.name}, ${category}: ${formatNumber(value)}`;
      bars.push(
        horizontal ? (
          <rect
            key={key}
            x={plot.left + low * plot.width}
            y={plot.top + along}
            width={(high - low) * plot.width}
            height={barSize}
            fill={color}
          >
            <title>{label}</title>
          </rect>
        ) : (
          <rect
            key={key}
            x={plot.left + along}
            y={plot.top + (1 - high) * plot.height}
            width={barSize}
            height={(high - low) * plot.height}
            fill={color}
          >
            <title>{label}</title>
          </rect>
        ),
      );
    });
  });

  return (
    <ChartFrame title={props.title} caption={props.caption} legend={legend}>
      <svg
        viewBox={`0 0 ${viewWidth} ${total}`}
        aria-label={props.title ?? "Bar chart"}
        className="w-full"
        style={{ height: "auto" }}
      >
        <Axes
          plot={plot}
          scale={scale}
          categories={props.categories}
          horizontal={horizontal}
          xAxisLabel={props.xAxisLabel}
          yAxisLabel={props.yAxisLabel}
          total={total}
        />
        {bars}
        <ReferenceLines
          plot={plot}
          scale={scale}
          lines={props.referenceLines ?? []}
          horizontal={horizontal}
        />
      </svg>
    </ChartFrame>
  );
}

export function LineChart(props: CartesianProps): ReactElement {
  const palette = usePalette();
  const scale = valueScale(props, null);
  const { plot, total } = plotArea(props);
  const ratio = (value: number) => (value - scale.min) / (scale.max - scale.min);
  const band = plot.width / props.categories.length;
  const legend = props.series.map((series, index) => ({
    name: series.name,
    color: seriesColor(palette, series, index),
  }));
  return (
    <ChartFrame title={props.title} caption={props.caption} legend={legend}>
      <svg
        viewBox={`0 0 ${viewWidth} ${total}`}
        aria-label={props.title ?? "Line chart"}
        className="w-full"
        style={{ height: "auto" }}
      >
        <Axes
          plot={plot}
          scale={scale}
          categories={props.categories}
          horizontal={false}
          xAxisLabel={props.xAxisLabel}
          yAxisLabel={props.yAxisLabel}
          total={total}
        />
        <ReferenceLines
          plot={plot}
          scale={scale}
          lines={props.referenceLines ?? []}
          horizontal={false}
        />
        {props.series.map((series, index) => {
          const color = seriesColor(palette, series, index);
          const points = keyed(props.categories, (c) => c).map(
            ({ key, item: category }, categoryIndex) => {
              const value = series.data[categoryIndex] ?? 0;
              return {
                key,
                category,
                value,
                x: plot.left + band * (categoryIndex + 0.5),
                y: plot.top + (1 - ratio(value)) * plot.height,
              };
            },
          );
          return (
            <g key={series.name}>
              <polyline
                points={points.map((point) => `${point.x},${point.y}`).join(" ")}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
              />
              {points.map((point) => (
                <circle key={point.key} cx={point.x} cy={point.y} r={3} fill={color}>
                  <title>{`${series.name}, ${point.category}: ${formatNumber(point.value)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
    </ChartFrame>
  );
}

export interface PieSlice {
  readonly label: string;
  readonly value: number;
  readonly tone?: Tone;
}

function arcPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  start: number,
  end: number,
): string {
  const point = (radius: number, angle: number) =>
    `${cx + radius * Math.cos(angle)} ${cy + radius * Math.sin(angle)}`;
  const large = end - start > Math.PI ? 1 : 0;
  return [
    `M ${point(outer, start)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${point(outer, end)}`,
    `L ${point(inner, end)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${point(inner, start)}`,
    "Z",
  ].join(" ");
}

export function PieChart(props: {
  readonly data: readonly PieSlice[];
  readonly title?: string;
  readonly caption?: string;
}): ReactElement {
  const palette = usePalette();
  const total = props.data.reduce((sum, slice) => sum + slice.value, 0);
  const size = 160;
  const cx = size / 2;
  const cy = size / 2;
  let angle = -Math.PI / 2;
  const slices = props.data.map((slice, index) => {
    const color =
      slice.tone === undefined
        ? (palette.series[index % palette.series.length] ?? palette.accent)
        : palette.tone[slice.tone];
    const fraction = total === 0 ? 0 : slice.value / total;
    const start = angle;
    const end = angle + fraction * Math.PI * 2;
    angle = end;
    return { ...slice, color, fraction, start, end };
  });
  return (
    <figure className="my-3 flex flex-col gap-2">
      {props.title !== undefined ? (
        <figcaption className="text-sm font-medium text-foreground">{props.title}</figcaption>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <svg
          viewBox={`0 0 ${size} ${size}`}
          aria-label={props.title ?? "Pie chart"}
          width={size}
          height={size}
        >
          {slices.map((slice) =>
            slice.fraction >= 0.9999 ? (
              <circle
                key={slice.label}
                cx={cx}
                cy={cy}
                r={(70 + 40) / 2}
                fill="none"
                stroke={slice.color}
                strokeWidth={30}
              >
                <title>{`${slice.label}: ${formatNumber(slice.value)}`}</title>
              </circle>
            ) : slice.fraction > 0 ? (
              <path
                key={slice.label}
                d={arcPath(cx, cy, 70, 40, slice.start, slice.end)}
                fill={slice.color}
              >
                <title>{`${slice.label}: ${formatNumber(slice.value)}`}</title>
              </path>
            ) : null,
          )}
        </svg>
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {slices.map((slice) => (
            <li key={slice.label} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block size-2.5 rounded-sm"
                style={{ backgroundColor: slice.color }}
              />
              <span className="text-foreground">{slice.label}</span>
              <span>
                {formatNumber(slice.value)} ({Math.round(slice.fraction * 100)}%)
              </span>
            </li>
          ))}
        </ul>
      </div>
      {props.caption !== undefined ? (
        <p className="text-xs text-muted-foreground">{props.caption}</p>
      ) : null}
    </figure>
  );
}

export function UsageBar(props: {
  readonly segments: readonly PieSlice[];
  readonly total: number;
  readonly labels?: { readonly left?: string; readonly right?: string };
}): ReactElement {
  const palette = usePalette();
  const used = props.segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <div className="my-3 flex flex-col gap-1.5">
      {props.labels !== undefined ? (
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{props.labels.left}</span>
          <span>{props.labels.right}</span>
        </div>
      ) : null}
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
        title={`${formatNumber(used)} of ${formatNumber(props.total)}`}
      >
        {props.segments.map((segment, index) => {
          const color =
            segment.tone === undefined
              ? (palette.series[index % palette.series.length] ?? palette.accent)
              : palette.tone[segment.tone];
          return (
            <div
              key={segment.label}
              title={`${segment.label}: ${formatNumber(segment.value)}`}
              style={{
                width: `${Math.min(100, (segment.value / props.total) * 100)}%`,
                backgroundColor: color,
              }}
            />
          );
        })}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {props.segments.map((segment, index) => {
          const color =
            segment.tone === undefined
              ? (palette.series[index % palette.series.length] ?? palette.accent)
              : palette.tone[segment.tone];
          return (
            <li key={segment.label} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block size-2.5 rounded-sm"
                style={{ backgroundColor: withAlpha(color, 1) }}
              />
              {segment.label} {formatNumber(segment.value)}
            </li>
          );
        })}
        <li>of {formatNumber(props.total)}</li>
      </ul>
    </div>
  );
}
