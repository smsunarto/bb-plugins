// Timings as a waterfall, the way DevTools' Network panel and a tracing UI
// show them: one shared time axis, each span a bar at its start and length,
// nested spans indented under their parent (collapsible), the duration at the
// bar's end. HAR requests split into their phases (queued, DNS, connect, TLS,
// send, waiting, download) with status and size, failures marked. The header
// gives the total and the critical path, which can dim everything else.
import { useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatAmount, formatBytes, formatMs, niceTicks } from "../../core/perf-units";
import { ancestry, PHASE_LABEL, PHASES, readWaterfall, type PhaseName, type Span, type Waterfall as WaterfallData } from "../../core/waterfall";
import { ACCENT, optionalText, TONE_TEXT, type Props } from "../values";
import { actionIntent } from "./action-logic";
import { TONE_STROKE } from "./chartKit";
import { ErrorLine } from "./display";
import { ActionHint, FOCUS_RING } from "./inputs";
import { CHART_DRAW_MS, SMOOTH_HEIGHT_CLASS, useEntrance, useSmoothHeight, type Entrance } from "./motion";
import { Frame, gridLines, Heading, Quiet, TEXT_BUTTON, useOpenUrl } from "./perfKit";

/** Rows shown before "Show N more", and how many each press adds. */
const ROW_PAGE = 60;
/** Indent per nesting level, capped so deep traces keep room for their names. */
const INDENT_PX = 12;
const MAX_INDENT_LEVELS = 6;

const GROW_X: Entrance = { keyframes: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], duration: CHART_DRAW_MS };

const PHASE_COLOR: Record<PhaseName, string> = {
  blocked: "color-mix(in oklab, var(--muted-foreground) 40%, var(--background))",
  dns: "color-mix(in oklab, var(--success) 50%, var(--color-timeline-accent, var(--primary)))",
  connect: "var(--warning)",
  ssl: "var(--attention)",
  send: "color-mix(in oklab, var(--success) 55%, var(--background))",
  wait: "var(--success)",
  receive: ACCENT,
};

const MARKER_COLOR: Record<string, string> = {
  DOMContentLoaded: ACCENT,
  Load: "var(--warning)",
};

/** The label column beside the bars from @md up; on narrow frames the label sits above its bar. */
const ROW_GRID = "grid min-w-0 grid-cols-1 @md:grid-cols-[minmax(0,34%)_minmax(0,1fr)] @md:gap-x-3";

export function Waterfall({ props }: { props: Props }) {
  const unit = optionalText(props.unit);
  const read = useMemo(() => readWaterfall(props.spans, unit), [props.spans, unit]);
  if (!read.ok) return <ErrorLine message={read.error} />;
  return (
    <Frame label="Waterfall">
      <WaterfallView data={read.waterfall} />
    </Frame>
  );
}

function noun(data: WaterfallData, count: number): string {
  const word = data.source === "har" ? "request" : data.source === "trace" ? "event" : "span";
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function WaterfallView({ data }: { data: WaterfallData }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const [critical, setCritical] = useState(false);
  const [shown, setShown] = useState(ROW_PAGE);
  const ticks = useMemo(() => niceTicks(0, data.total > 0 ? data.total : 1), [data.total]);
  const span = ticks[ticks.length - 1];
  const onPath = useMemo(() => new Set(data.critical), [data.critical]);
  const visible = useMemo(() => {
    const rows: Span[] = [];
    let hideDeeperThan: number | null = null;
    for (const item of data.spans) {
      if (hideDeeperThan !== null) {
        if (item.depth > hideDeeperThan) continue;
        hideDeeperThan = null;
      }
      rows.push(item);
      if (collapsed.has(item.index) && item.children.length > 0) hideDeeperThan = item.depth;
    }
    return rows;
  }, [data.spans, collapsed]);

  const counted = data.spans.filter((item) => !item.track);
  if (counted.length === 0) return <Quiet>No timings to show{data.ignored > 0 ? ` (${data.ignored} items without a name or times)` : ""}.</Quiet>;

  const failed = counted.filter((item) => item.failed).length;
  const transferred = data.source === "har" ? counted.reduce((sum, item) => sum + (item.request?.transfer ?? item.request?.size ?? 0), 0) : 0;
  const phasesUsed = PHASES.filter((name) => counted.some((item) => item.phases.some((phase) => phase.name === name)));
  const meta = [
    data.source === "har" && transferred > 0 ? `${formatBytes(transferred)} transferred` : null,
    ...data.markers.map((marker) => `${marker.label} ${formatMs(marker.at)}`),
    data.ignored > 0 ? `${data.ignored} unreadable left out` : null,
  ].filter((part) => part !== null);
  const rest = visible.length - shown;
  const toggle = (index: number) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <>
      <Heading
        title={
          <>
            {noun(data, counted.length)} · {formatMs(data.total)}
            {failed > 0 ? <span className="ml-2 text-[13px] font-medium text-destructive">{failed} failed</span> : null}
          </>
        }
        meta={meta.length === 0 ? null : meta.join(" · ")}
        aside={
          data.critical.length > 0 ? (
            <button
              type="button"
              aria-pressed={critical}
              onClick={() => setCritical((value) => !value)}
              title="The chain of spans that decided when everything finished"
              className={cn(
                "mt-0.5 flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs leading-6 tabular-nums transition-colors duration-150",
                FOCUS_RING,
                critical ? "bg-foreground text-background" : "bg-surface-recessed text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon name="Workflow" aria-hidden className="size-3.5" />
              Critical path · {formatMs(data.criticalMs)}
            </button>
          ) : null
        }
      />
      {phasesUsed.length > 0 || data.markers.length > 0 ? (
        <div aria-hidden className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-4 text-muted-foreground">
          {phasesUsed.map((name) => (
            <span key={name} className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-[2px]" style={{ background: PHASE_COLOR[name] }} />
              {PHASE_LABEL[name]}
            </span>
          ))}
          {data.markers.map((marker) => (
            <span key={marker.label} className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-0 border-l border-dashed" style={{ borderColor: MARKER_COLOR[marker.label] ?? ACCENT }} />
              {marker.label}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-col">
        <Axis ticks={ticks} />
        <ul className="m-0 min-w-0 list-none p-0" aria-label="Timings">
          {visible.slice(0, shown).map((item) => (
            <Row
              key={item.index}
              data={data}
              span={item}
              domain={span}
              step={ticks[1] - ticks[0]}
              open={selected === item.index}
              collapsed={collapsed.has(item.index)}
              dimmed={critical && !onPath.has(item.index)}
              critical={onPath.has(item.index)}
              onSelect={() => setSelected((value) => (value === item.index ? null : item.index))}
              onToggle={() => toggle(item.index)}
            />
          ))}
        </ul>
      </div>
      {rest > 0 ? (
        <button type="button" onClick={() => setShown((count) => count + ROW_PAGE)} className={TEXT_BUTTON}>
          Show {Math.min(rest, ROW_PAGE)} more of {rest} rows
        </button>
      ) : null}
    </>
  );
}

function Axis({ ticks }: { ticks: readonly number[] }) {
  const end = ticks[ticks.length - 1];
  return (
    <div aria-hidden className={cn(ROW_GRID, "border-b border-border pb-0.5")}>
      <span className="hidden @md:block" />
      <span className="relative block h-4">
        {ticks.map((tick, index) => (
          <span
            key={tick}
            className="absolute top-0 whitespace-nowrap text-[10.5px] leading-4 tabular-nums text-muted-foreground"
            style={{
              left: `${(tick / end) * 100}%`,
              transform: index === 0 ? undefined : index === ticks.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            {formatAmount(tick, "ms", 3, end)}
          </span>
        ))}
      </span>
    </div>
  );
}

/** A request's status as a short word: the code, or why there was none. */
function statusText(item: Span): string | null {
  const request = item.request;
  if (request === null) return null;
  if (request.status > 0) return String(request.status);
  if (request.failure !== null && /BLOCKED_BY_CLIENT/.test(request.failure)) return "blocked";
  return "failed";
}

function Row({
  data,
  span,
  domain,
  step,
  open,
  collapsed,
  dimmed,
  critical,
  onSelect,
  onToggle,
}: {
  data: WaterfallData;
  span: Span;
  domain: number;
  step: number;
  open: boolean;
  collapsed: boolean;
  dimmed: boolean;
  critical: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const { outer, inner } = useSmoothHeight<HTMLLIElement, HTMLDivElement>();
  const left = (span.start / domain) * 100;
  const width = Math.max(0, ((span.end - span.start) / domain) * 100);
  const end = left + width;
  const duration = formatMs(span.end - span.start);
  const status = statusText(span);
  const size = span.request?.transfer ?? span.request?.size ?? null;
  const indent = Math.min(span.depth, MAX_INDENT_LEVELS) * INDENT_PX;
  const label = `${span.name}, starts at ${formatMs(span.start)}, takes ${duration}${status === null ? "" : `, ${status}`}${critical ? ", on the critical path" : ""}`;
  // The duration sits after the bar's end, or before its start when the bar ends near the right edge.
  const durationStyle: CSSProperties =
    end <= 78 ? { left: `calc(${end}% + 4px)` } : left >= 22 ? { right: `calc(${100 - left}% + 4px)` } : { right: `calc(${100 - end}% + 4px)` };
  const inside = end > 78 && left < 22;
  return (
    <li ref={outer} className={cn("min-w-0 border-b border-border/40 last:border-b-0", SMOOTH_HEIGHT_CLASS)}>
      <div ref={inner} className="min-w-0">
        <div
          className={cn(ROW_GRID, "items-center rounded-sm transition-opacity duration-200", open && "bg-surface-recessed", dimmed && "opacity-35")}
          onPointerEnter={(event) => event.pointerType === "mouse" && setHovered(true)}
          onPointerLeave={() => setHovered(false)}
        >
          <div className="flex h-5 min-w-0 items-center gap-1 @md:h-[26px]" style={{ paddingLeft: indent }}>
            {span.children.length > 0 ? (
              <button
                type="button"
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? "Expand" : "Collapse"} ${span.name}`}
                onClick={onToggle}
                className={cn("flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground", FOCUS_RING)}
              >
                <Icon name="ChevronRight" className={cn("size-3 transition-transform duration-200 motion-reduce:transition-none", !collapsed && "rotate-90")} />
              </button>
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`${id}-detail`}
              aria-label={label}
              onClick={onSelect}
              className={cn("flex min-w-0 flex-1 cursor-pointer items-baseline gap-1.5 rounded-sm text-left", FOCUS_RING)}
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs leading-5",
                  span.track ? "font-semibold text-foreground" : span.failed ? "text-destructive" : "text-foreground",
                  data.source === "har" && "font-mono text-[11.5px]",
                )}
                title={span.request?.url ?? span.name}
              >
                {span.name}
              </span>
              {status === null ? null : (
                <span className={cn("shrink-0 text-[10.5px] tabular-nums", span.failed ? "font-medium text-destructive" : "text-muted-foreground")}>{status}</span>
              )}
              {size === null ? null : <span className="hidden shrink-0 text-[10.5px] tabular-nums text-muted-foreground @lg:inline">{formatBytes(size)}</span>}
            </button>
          </div>
          <div
            aria-hidden
            onClick={onSelect}
            className="relative h-4 min-w-0 cursor-pointer @md:h-[26px]"
            style={{ backgroundImage: gridLines(step, domain) }}
          >
            {data.markers.map((marker) => (
              <span
                key={marker.label}
                className="absolute inset-y-0 w-0 border-l border-dashed opacity-70"
                style={{ left: `${(marker.at / domain) * 100}%`, borderColor: MARKER_COLOR[marker.label] ?? ACCENT }}
              />
            ))}
            <Bar span={span} left={left} width={width} />
            <span
              className={cn(
                "absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[10.5px] leading-4 tabular-nums",
                inside ? "rounded-sm bg-background/85 px-1 text-foreground" : "text-muted-foreground",
              )}
              style={durationStyle}
            >
              {duration}
            </span>
            {hovered ? (
              <span
                className="pointer-events-none absolute bottom-full z-10 mb-0.5 whitespace-nowrap rounded-md border border-border bg-background px-1.5 text-[10.5px] leading-[18px] tabular-nums text-foreground shadow-[0_4px_12px_rgb(0_0_0/0.08)]"
                style={left < 60 ? { left: `${left}%` } : { right: `${100 - end}%` }}
              >
                {formatMs(span.start)} → {formatMs(span.end)} · {duration}
              </span>
            ) : null}
          </div>
        </div>
        <div id={`${id}-detail`} role="region" aria-label={`${span.name} details`} hidden={!open} className={open ? "block" : "hidden"}>
          {open ? <Detail data={data} span={span} /> : null}
        </div>
      </div>
    </li>
  );
}

function Bar({ span, left, width }: { span: Span; left: number; width: number }) {
  const grow = useEntrance<HTMLDivElement>(GROW_X);
  const duration = span.end - span.start;
  const color = span.track
    ? "color-mix(in oklab, var(--muted-foreground) 22%, var(--background))"
    : span.failed
      ? "var(--destructive)"
      : span.tone !== null
        ? TONE_STROKE[span.tone]
        : ACCENT;
  return (
    <div
      ref={grow}
      // Centred by margin, not translate: the grow-in animation owns `transform`.
      className={cn("absolute top-1/2 min-w-[2px] origin-left overflow-hidden rounded-[3px]", span.track ? "-mt-[3px] h-1.5" : "-mt-[5px] h-2.5")}
      style={{ left: `${left}%`, width: `${width}%`, background: span.phases.length > 0 && !span.failed ? "color-mix(in oklab, var(--muted-foreground) 18%, var(--background))" : color }}
    >
      {span.failed
        ? null
        : span.phases.map((phase) => (
            <span
              key={phase.name}
              className="absolute inset-y-0"
              style={{
                left: `${duration > 0 ? ((phase.start - span.start) / duration) * 100 : 0}%`,
                width: `${duration > 0 ? (phase.duration / duration) * 100 : 0}%`,
                background: PHASE_COLOR[phase.name],
              }}
            />
          ))}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 truncate tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

function Detail({ data, span }: { data: WaterfallData; span: Span }) {
  const openUrl = useOpenUrl();
  const parents = ancestry(data.spans, span.index);
  const childTime = span.children.reduce((sum, child) => sum + (data.spans[child].end - data.spans[child].start), 0);
  const request = span.request;
  const duration = span.end - span.start;
  return (
    <div className="flex min-w-0 flex-col gap-2 px-2 pb-2.5 pt-1.5 text-xs leading-5" style={{ paddingLeft: Math.min(span.depth, MAX_INDENT_LEVELS) * INDENT_PX + 28 }}>
      {request === null ? null : (
        <div className="flex min-w-0 items-start gap-2">
          <span className="shrink-0 font-mono text-[11px] font-medium text-muted-foreground">{request.method}</span>
          <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground">{request.url}</span>
          {/^https?:\/\//i.test(request.url) ? (
            <ActionHint hint={actionIntent([{ kind: "action", type: "openUrl", url: request.url }]).hint}>
              <button type="button" onClick={() => openUrl(request.url)} className={cn(TEXT_BUTTON, "inline-flex items-center gap-1")}>
                Open
                <Icon name="ExternalLink" aria-hidden className="size-3 shrink-0" />
              </button>
            </ActionHint>
          ) : null}
        </div>
      )}
      <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-x-4 gap-y-0.5">
        <Fact label="Start">{formatMs(span.start)}</Fact>
        <Fact label="Duration">{formatMs(duration)}</Fact>
        <Fact label="End">{formatMs(span.end)}</Fact>
        {span.children.length > 0 && !span.track ? <Fact label="Self">{formatMs(Math.max(0, duration - childTime))}</Fact> : null}
        {request === null ? null : (
          <>
            <Fact label="Status">
              <span className={span.failed ? TONE_TEXT.bad : ""}>
                {request.status > 0 ? `${request.status}${request.statusText === "" ? "" : ` ${request.statusText}`}` : (request.failure ?? "No response")}
              </span>
            </Fact>
            {request.type === null ? null : <Fact label="Type">{request.type}</Fact>}
            {request.size === null ? null : <Fact label="Size">{formatBytes(request.size)}</Fact>}
            {request.transfer === null ? null : <Fact label="Transferred">{formatBytes(request.transfer)}</Fact>}
          </>
        )}
      </dl>
      {span.phases.length > 0 && !span.failed ? (
        <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-x-4 gap-y-0.5">
          {span.phases.map((phase) => (
            <div key={phase.name} className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: PHASE_COLOR[phase.name] }} />
              <dt className="text-muted-foreground">{PHASE_LABEL[phase.name]}</dt>
              <dd className="m-0 tabular-nums text-foreground">{formatMs(phase.duration)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {parents.length > 0 ? <p className="m-0 truncate text-muted-foreground">In {parents.map((parent) => parent.name).join(" › ")}</p> : null}
      {span.detail === null ? null : <p className="m-0 [overflow-wrap:anywhere] text-muted-foreground">{span.detail}</p>}
    </div>
  );
}
