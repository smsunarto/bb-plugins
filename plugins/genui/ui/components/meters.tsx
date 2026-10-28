// One value against a range (Gauge) and shares of one whole (SegmentedBar).
// Both draw in like the charts, slide when their values change, and print
// their numbers: color is never the only way to read them.
import { useState } from "react";
import { cn } from "@/lib/utils";
import { finiteNumber, formatNumber, isObject, list, optionalText, text, tone, type Props } from "../values";
import { formatValue, mouseLeave, sliceColor, TONE_STROKE } from "./chartKit";
import { dialPoint, intensity, percentages } from "./chartMath";
import { ErrorLine } from "./display";
import { CHART_DRAW_MS, useEntrance, type Entrance } from "./motion";

const DIAL_WIDTH = 200;
const DIAL_STROKE = 14;
const DIAL_RADIUS = (DIAL_WIDTH - DIAL_STROKE) / 2;
/** The arc's centre, on the line its ends rest on; the round caps hang half a stroke below it. */
const DIAL_CENTER_Y = DIAL_RADIUS + DIAL_STROKE / 2;
const DIAL_HEIGHT = DIAL_CENTER_Y + DIAL_STROKE / 2;
/** Value changes slide; the class yields to reduced motion, which inline styles would not. */
const SLIDE = "duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none";

/** A semicircular dial: the arc fills from `min` (default 0) to `max` (default 100) up to `value`. */
export function Gauge({ props }: { props: Props }) {
  const value = finiteNumber(props.value);
  const min = finiteNumber(props.min) ?? 0;
  const max = finiteNumber(props.max) ?? 100;
  const ratio = value === null ? 0 : intensity(value, min, max);
  // The arc draws from nothing to the value once; later values slide along it.
  const fill = useEntrance<SVGPathElement>({
    keyframes: [{ strokeDasharray: "0 1" }, { strokeDasharray: `${ratio} 1` }],
    duration: CHART_DRAW_MS,
  });
  if (value === null) return <ErrorLine message="Gauge needs a number value" />;
  if (!(max > min)) return <ErrorLine message={`Gauge needs max above min (got ${formatNumber(min)} to ${formatNumber(max)})`} />;
  const label = optionalText(props.label);
  const color = TONE_STROKE[tone(props.tone)];
  const [x0, y0] = dialPoint(DIAL_WIDTH / 2, DIAL_CENTER_Y, DIAL_RADIUS, 0);
  const [x1, y1] = dialPoint(DIAL_WIDTH / 2, DIAL_CENTER_Y, DIAL_RADIUS, 1);
  const arc = `M${x0},${y0} A${DIAL_RADIUS},${DIAL_RADIUS} 0 0 1 ${x1},${y1}`;
  const outside = value < min ? "below the range" : value > max ? "above the range" : "";
  return (
    <div
      role="meter"
      aria-label={label ?? "Gauge"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.min(max, Math.max(min, value))}
      aria-valuetext={`${formatNumber(value)} on a scale from ${formatNumber(min)} to ${formatNumber(max)}${outside === "" ? "" : `, ${outside}`}`}
      className="flex min-w-0 flex-col items-center gap-1"
    >
      <div className="relative" style={{ width: DIAL_WIDTH, height: DIAL_HEIGHT }}>
        <svg width={DIAL_WIDTH} height={DIAL_HEIGHT} aria-hidden className="block">
          <path d={arc} fill="none" stroke="var(--muted)" strokeWidth={DIAL_STROKE} strokeLinecap="round" />
          <path
            ref={fill}
            d={arc}
            pathLength={1}
            fill="none"
            stroke={color}
            strokeWidth={DIAL_STROKE}
            strokeLinecap="round"
            strokeDasharray={`${ratio} 1`}
            className={cn("transition-[stroke-dasharray]", SLIDE)}
          />
        </svg>
        <span className="absolute inset-x-0 bottom-0 text-center text-2xl font-semibold leading-8 tracking-[-0.02em] tabular-nums text-foreground">
          {formatNumber(value)}
        </span>
      </div>
      <div
        aria-hidden
        className="flex justify-between text-[10.5px] leading-4 tabular-nums text-muted-foreground"
        style={{ width: DIAL_WIDTH }}
      >
        <span>{formatNumber(min)}</span>
        <span>{formatNumber(max)}</span>
      </div>
      {label === null ? null : <span className="max-w-full truncate text-xs leading-5 text-muted-foreground">{label}</span>}
    </div>
  );
}

/** The bar grows from the left on mount; later shares slide. */
const GROW_X: Entrance = {
  keyframes: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
  duration: CHART_DRAW_MS,
};
/** An explicit neutral part reads as the quiet remainder. */
const NEUTRAL_PART = "color-mix(in oklch, var(--muted-foreground) 45%, var(--background))";

interface Part {
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

/** `{label, value, tone?}` parts with a number at or above zero; anything else is dropped. */
function readParts(parts: readonly unknown[]): Part[] {
  return parts.flatMap((part, position): Part[] => {
    if (!isObject(part)) return [];
    const value = finiteNumber(part.value);
    if (value === null || value < 0) return [];
    const toneName = part.tone === undefined || part.tone === null ? null : tone(part.tone as Props[string]);
    return [
      {
        label: text(part.label) || `Part ${position + 1}`,
        value,
        color: toneName === null ? sliceColor(position) : toneName === "neutral" ? NEUTRAL_PART : TONE_STROKE[toneName],
      },
    ];
  });
}

/** One full-width bar split into parts, with a legend of each part's value and share. */
export function SegmentedBar({ props }: { props: Props }) {
  const grow = useEntrance<HTMLDivElement>(GROW_X);
  const [hover, setHover] = useState<number | null>(null);
  const given = list(props.parts);
  const parts = readParts(given);
  if (parts.length === 0) {
    return given.length === 0 ? null : <ErrorLine message="SegmentedBar parts need {label, value} with a number of 0 or more" />;
  }
  const unit = optionalText(props.unit);
  const shares = percentages(parts.map((part) => part.value));
  const share = (index: number) => (shares[index] === 0 && parts[index]!.value > 0 ? "<1%" : `${shares[index]}%`);
  const summary = parts.map((part, index) => `${part.label} ${formatValue(part.value, unit)} (${share(index)})`).join(", ");
  return (
    <div className="flex min-w-0 flex-col gap-2.5" onPointerLeave={mouseLeave(() => setHover(null))}>
      <div
        ref={grow}
        role="img"
        aria-label={summary}
        className="flex h-2.5 w-full origin-left gap-[2px] overflow-hidden rounded-full bg-muted"
      >
        {parts.map((part, index) =>
          part.value > 0 ? (
            <div
              key={index}
              className={cn(
                "h-full min-w-[3px] transition-[flex-grow,opacity]",
                SLIDE,
                hover !== null && hover !== index && "opacity-35",
              )}
              style={{ flex: `${part.value} 1 0`, background: part.color }}
              onPointerEnter={() => setHover(index)}
            />
          ) : null,
        )}
      </div>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-5 p-0 text-xs">
        {parts.map((part, index) => (
          <li
            key={index}
            className={cn(
              "flex min-w-0 items-center gap-2 leading-6 transition-opacity duration-150",
              hover !== null && hover !== index && "opacity-50",
            )}
            onPointerEnter={() => setHover(index)}
          >
            <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: part.color }} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{part.label}</span>
            <span className="font-medium tabular-nums text-foreground">{formatValue(part.value, unit)}</span>
            <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">{share(index)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
