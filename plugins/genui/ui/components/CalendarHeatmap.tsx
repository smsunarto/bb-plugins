// A GitHub-style calendar heatmap: one column per week (Sunday on top), one
// square per day from the first date to the last, shaded in four steps of the
// busiest day. Days are whole UTC day numbers (calendarMath.ts), so a date
// string is always drawn on its own day. Wider than the frame, it scrolls and
// opens on the latest weeks.
import { useId, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { CAPTION, FOCUS_RING } from "./inputs";
import { formatNumber, optionalText, tone, type Props } from "../values";
import { calendarLayout, calendarStats, dayLabel, readDays, weekday } from "./calendarMath";
import { AXIS_TEXT, ChartTooltip, mouseLeave, NO_DATA, SweepMask, TONE_STROKE, TooltipRow, useWidth } from "./chartKit";
import { heatLevel } from "./chartMath";
import { ErrorLine } from "./display";

const GAP = 3;
/** 9px squares keep a full year (53 weeks) inside a desktop chat column. */
const MIN_CELL = 9;
const MAX_CELL = 16;
/** The weekday names' column. */
const DAY_LABELS_WIDTH = 30;
/** The month names' row. */
const MONTH_ROW = 16;
const LEVELS = 4;
/** Shade of each level above zero, as a share of the tone. */
const LEVEL_MIX = [30, 52, 76, 100] as const;
const EMPTY = "color-mix(in oklch, var(--muted-foreground) 13%, var(--background))";
const WEEKDAY_ROWS = [
  [1, "Mon"],
  [3, "Wed"],
  [5, "Fri"],
] as const;

/** `{yyyy-mm-dd: n}` or `[{date, value}]` as weeks × weekdays, with month names and a scale. */
export function CalendarHeatmap({ props }: { props: Props }) {
  const [frame, width] = useWidth<HTMLDivElement>();
  const scroller = useRef<HTMLDivElement>(null);
  const maskId = useId();
  const [active, setActive] = useState<number | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const { values, dropped } = readDays(props.days);
  const days = [...values.keys()];
  const first = days.length === 0 ? 0 : Math.min(...days);
  const last = days.length === 0 ? 0 : Math.max(...days);
  const layout = calendarLayout(first, last);
  const room = Math.max(0, width - DAY_LABELS_WIDTH);
  const pitch = Math.min(MAX_CELL + GAP, Math.max(MIN_CELL + GAP, Math.floor(room / layout.weeks)));
  const cell = pitch - GAP;
  const gridWidth = layout.weeks * pitch - GAP;

  // Opens on the latest weeks when the calendar is wider than the frame.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null) element.scrollLeft = element.scrollWidth;
    // `width` too: the first pass has no grid yet, and the measured one may keep the same pitch.
  }, [layout.weeks, pitch, width]);
  // Keys move the readout off screen: bring its day into view.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null || active === null) return;
    const x = Math.floor((active - layout.start) / 7) * pitch;
    if (x < element.scrollLeft) element.scrollLeft = x;
    else if (x + cell > element.scrollLeft + element.clientWidth) element.scrollLeft = x + cell - element.clientWidth;
  }, [active]);

  if (values.size === 0) {
    return dropped === 0 ? NO_DATA : <ErrorLine message="CalendarHeatmap days need yyyy-mm-dd dates with numbers" />;
  }
  const label = optionalText(props.label);
  const color = TONE_STROKE[tone(props.tone)];
  const stats = calendarStats(values);
  const peak = stats.peak!.value;
  const shade = (level: number) =>
    level === 0 ? EMPTY : `color-mix(in oklab, ${color} ${LEVEL_MIX[level - 1]}%, var(--background))`;
  const dayColor = (day: number) => {
    const value = values.get(day);
    return shade(value === undefined ? 0 : heatLevel(value, peak, LEVELS));
  };
  const place = (day: number) => ({ x: Math.floor((day - layout.start) / 7) * pitch, y: MONTH_ROW + weekday(day) * pitch });
  const height = MONTH_ROW + 7 * pitch - GAP;
  const summary = `${label ?? "Calendar"}: ${formatNumber(stats.total)} in total over ${last - first + 1} days, ${dayLabel(first)} to ${dayLabel(last)}; ${stats.active} active days; busiest ${dayLabel(stats.peak!.day)} with ${formatNumber(peak)}. Arrow keys move by day and week.`;

  const cells = [];
  for (let day = first; day <= last; day++) {
    const { x, y } = place(day);
    cells.push(<rect key={day} x={x} y={y} width={cell} height={cell} rx={2} fill={dayColor(day)} />);
  }
  const shown = active === null ? null : place(active);
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const week = Math.floor((event.clientX - box.left) / pitch);
    const row = Math.floor((event.clientY - box.top - MONTH_ROW) / pitch);
    const day = layout.start + week * 7 + row;
    if (row >= 0 && row < 7 && day >= first && day <= last) setActive(day);
    else if (event.pointerType === "mouse") setActive(null);
  };
  const shownValue = active === null ? undefined : values.get(active);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className={cn(CAPTION, "min-w-0 truncate")}>{label}</span>
        <span className="text-xs leading-5 tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">{formatNumber(stats.total)}</span> total
        </span>
      </div>
      <div
        ref={frame}
        tabIndex={0}
        role="group"
        aria-label={summary}
        className={cn("relative flex w-full min-w-0 rounded-sm", FOCUS_RING)}
        onPointerLeave={mouseLeave(() => setActive(null))}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          const moves: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
          if (event.key === "Escape") return setActive(null);
          let next: number;
          if (event.key === "Home") next = first;
          else if (event.key === "End") next = last;
          else if (Object.hasOwn(moves, event.key)) next = active === null ? last : active + moves[event.key]!;
          else return;
          event.preventDefault();
          setActive(Math.min(last, Math.max(first, next)));
        }}
      >
        <svg width={DAY_LABELS_WIDTH} height={height} aria-hidden className="block shrink-0">
          {WEEKDAY_ROWS.map(([row, name]) => (
            <text key={name} x={0} y={MONTH_ROW + row * pitch + cell / 2} dominantBaseline="central" className={AXIS_TEXT}>
              {name}
            </text>
          ))}
        </svg>
        <div
          ref={scroller}
          className={cn(
            "min-w-0 flex-1 overflow-x-auto [scrollbar-width:thin]",
            // Weeks hidden off the left edge fade out rather than end in a hard cut.
            scrollLeft > 0 && "[mask-image:linear-gradient(to_right,transparent,black_20px)]",
          )}
          onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        >
          {width === 0 ? (
            <div style={{ height }} />
          ) : (
            <svg
              width={gridWidth}
              height={height}
              aria-hidden
              className="block"
              onPointerMove={pick}
              onPointerDown={pick}
            >
              <defs>
                <SweepMask id={maskId} width={gridWidth} height={height} />
              </defs>
              {layout.months.map((month) => (
                <text key={month.week} x={month.week * pitch} y={11} className={AXIS_TEXT}>
                  {month.label}
                </text>
              ))}
              <g mask={`url(#${maskId})`}>{cells}</g>
              {shown === null ? null : (
                <rect
                  x={shown.x - 1}
                  y={shown.y - 1}
                  width={cell + 2}
                  height={cell + 2}
                  rx={3}
                  fill="none"
                  stroke="var(--foreground)"
                  strokeWidth={1.5}
                />
              )}
            </svg>
          )}
        </div>
        {shown === null || active === null || width === 0 ? null : (
          <ChartTooltip
            x={DAY_LABELS_WIDTH + shown.x - scrollLeft + cell / 2}
            top={shown.y}
            bottom={shown.y + cell}
            width={width}
          >
            <div className="mb-1 font-medium text-foreground">{dayLabel(active)}</div>
            <TooltipRow
              color={dayColor(active)}
              name={label ?? "Value"}
              value={shownValue === undefined ? "No data" : formatNumber(shownValue)}
            />
          </ChartTooltip>
        )}
      </div>
      <div aria-hidden className="flex items-center justify-end gap-1 text-[10.5px] text-muted-foreground">
        <span className="mr-1">Less</span>
        {Array.from({ length: LEVELS + 1 }, (_, level) => (
          <span key={level} className="size-2.5 rounded-[2px]" style={{ background: shade(level) }} />
        ))}
        <span className="ml-1">More</span>
      </div>
    </div>
  );
}
