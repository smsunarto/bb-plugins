import { useContext } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { InTableContext, useUiRuntime } from "../runtime";
import {
  finiteNumber,
  formatNumber,
  isObject,
  list,
  optionalText,
  text,
  tone,
  INFO_WASH,
  TONE_BADGE,
  TONE_DOT,
  TONE_TEXT,
  type Props,
} from "../values";
import { CHART_DRAW_MS, EASE_OUT_EXPO, FADE, RISE, useEntrance, type Entrance } from "./motion";
import { Badge as BadgeView } from "@/components/ui/badge";
import { Progress as ProgressBar } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { WithTooltip } from "./iconButton";

export function Text({ props }: { props: Props }) {
  const ref = useEntrance<HTMLDivElement>(FADE);
  return (
    <div ref={ref} className="min-w-0">
      <Markdown
        content={text(props.text)}
        className={cn("min-w-0 text-sm", TONE_TEXT[tone(props.tone)])}
      />
    </div>
  );
}

export function Metric({ props }: { props: Props }) {
  const note = optionalText(props.note);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-xs text-muted-foreground">{text(props.label)}</span>
      <span
        className={cn(
          "break-words text-xl font-semibold leading-7 tracking-[-0.02em] tabular-nums",
          TONE_TEXT[tone(props.tone)] || "text-foreground",
        )}
      >
        {text(props.value)}
      </span>
      {note === null ? null : (
        <span className="text-xs leading-4 text-muted-foreground">{note}</span>
      )}
    </div>
  );
}

/**
 * A status. Standalone it is a small tinted pill; in a table cell, where
 * models put whole verdict sentences, it is a colored dot before plain text.
 */
export function Badge({ props }: { props: Props }) {
  const inTable = useContext(InTableContext);
  const toneName = tone(props.tone);
  const label = text(props.text);
  if (inTable) {
    return (
      <span className="flex min-w-0 items-start gap-2 leading-5 text-foreground">
        <span
          aria-hidden
          className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", TONE_DOT[toneName])}
        />
        {/* Short statuses ("1-2 days", "+50%") never break mid-value. */}
        <span className={cn("min-w-0", label.length <= 16 && "whitespace-nowrap")}>{label}</span>
      </span>
    );
  }
  return (
    <BadgeView variant={TONE_BADGE[toneName]} className="w-fit max-w-full self-start whitespace-normal font-medium [overflow-wrap:anywhere]">
      {label}
    </BadgeView>
  );
}

export function File({ props }: { props: Props }) {
  const { openFile } = useUiRuntime();
  const path = text(props.path);
  const line = finiteNumber(props.line);
  const label = line === null ? path : `${path}:${line}`;
  const content = (
    <>
      <Icon name="FileText" className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </>
  );
  if (openFile === null) {
    return (
      <span className="inline-flex w-fit max-w-full items-center gap-1.5 self-start font-mono text-xs text-muted-foreground">
        {content}
      </span>
    );
  }
  return (
    <WithTooltip tip={`Open ${label}`}>
      <button
        type="button"
        onClick={async () => {
          if (!(await openFile(path))) toast.error(`Couldn't open ${path}`);
        }}
        className="inline-flex w-fit max-w-full cursor-pointer items-center gap-1.5 self-start rounded-sm font-mono text-xs text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {content}
      </button>
    </WithTooltip>
  );
}

/** The fill grows from the left on mount; later value changes slide. */
const FILL: Entrance = {
  keyframes: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
  duration: CHART_DRAW_MS,
};

export function Progress({ props }: { props: Props }) {
  const fill = useEntrance<HTMLDivElement>(FILL);
  const value = finiteNumber(props.value) ?? 0;
  const explicitMax = finiteNumber(props.max);
  const max = explicitMax ?? 100;
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const label = optionalText(props.label);
  const toneName = tone(props.tone);
  const readout =
    explicitMax === null ? `${Math.round(ratio * 100)}%` : `${formatNumber(value)}/${formatNumber(explicitMax)}`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs leading-4">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className="shrink-0 font-medium tabular-nums text-foreground">{readout}</span>
      </div>
      <ProgressBar
        aria-label={label ?? undefined}
        value={value}
        max={max}
        indicatorRef={fill}
        indicatorClassName={
          toneName === "neutral" ? "bg-[var(--color-timeline-accent,var(--primary))]" : TONE_DOT[toneName]
        }
        indicatorStyle={{ transitionTimingFunction: EASE_OUT_EXPO }}
      />
    </div>
  );
}

/** A check drawn in currentColor; host icon names are not guaranteed. */
export function CheckMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className}>
      <path
        d="M3.5 8.5l3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type StepStatus = "done" | "current" | "todo" | "blocked";

const STEP_MARKER: Record<StepStatus, string> = {
  done: "bg-success/12 text-success",
  current: INFO_WASH,
  todo: "bg-surface-recessed text-muted-foreground",
  blocked: "bg-destructive/10 text-destructive",
};

function Step({
  index,
  title,
  detail,
  status,
  last,
}: {
  index: number;
  title: string;
  detail: string | null;
  status: StepStatus;
  last: boolean;
}) {
  const ref = useEntrance<HTMLLIElement>(RISE);
  return (
    <li ref={ref} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums",
            STEP_MARKER[status],
          )}
        >
          {status === "done" ? <CheckMark className="size-3" /> : status === "blocked" ? "!" : index + 1}
        </span>
        {last ? null : (
          <span aria-hidden className={cn("my-1 w-px flex-1", status === "done" ? "bg-success/40" : "bg-border")} />
        )}
      </div>
      <div className={cn("flex min-w-0 flex-col gap-0.5", !last && "pb-3")}>
        <span
          className={cn(
            "text-sm leading-5",
            status === "current" && "font-medium",
            status === "todo" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {title}
          {status === "blocked" ? <span className="ml-2 text-xs text-destructive">Blocked</span> : null}
        </span>
        {detail === null ? null : <span className="text-xs leading-4 text-muted-foreground">{detail}</span>}
      </div>
    </li>
  );
}

/** A vertical stepper: numbered markers joined by a line, colored by status. */
export function Steps({ props }: { props: Props }) {
  const items = list(props.items);
  return (
    <ol className="m-0 flex min-w-0 list-none flex-col p-0">
      {items.map((item, index) => {
        // A bare string is a step with only a title.
        const fields: Readonly<Record<string, unknown>> = isObject(item) ? item : { title: item };
        const status = fields.status;
        return (
          <Step
            key={index}
            index={index}
            title={text(fields.title)}
            detail={optionalText(fields.detail)}
            status={status === "done" || status === "current" || status === "blocked" ? status : "todo"}
            last={index === items.length - 1}
          />
        );
      })}
    </ol>
  );
}

export function ErrorLine({ message }: { message: string }) {
  return (
    <p className="truncate text-xs text-destructive" title={message}>
      {message}
    </p>
  );
}

/** Components that take one line of text; anything else waits as a block. */
const LINE_SIZED: Partial<Record<string, true>> = {
  Text: true,
  Badge: true,
  Metric: true,
  Icon: true,
  Progress: true,
  Sparkline: true,
  Button: true,
  File: true,
  KeyValue: true,
};

/**
 * In place of a component whose file is still being read: a quiet shape about
 * its size, never a message. The block's remembered height (LiveUi) keeps the
 * reply from growing when the file arrives.
 */
export function LoadingPlaceholder({ path, component }: { path: string; component: string | null }) {
  const name = path.split("/").pop() ?? path;
  return (
    <Skeleton
      role="status"
      aria-label={`Loading ${name}`}
      className={cn("motion-reduce:animate-none", component !== null && LINE_SIZED[component] === true ? "h-5 w-2/3" : "h-24 w-full rounded-lg")}
    />
  );
}
