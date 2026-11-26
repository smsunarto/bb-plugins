import type {
  HeaderBarGlyph,
  HeaderBarTaskPriority,
  HeaderBarTaskStatus,
  HeaderBarTone,
} from "@bb-plugins/header-bar";
import { Icon } from "../components/ui/icon.tsx";
import { cn } from "../lib/utils.ts";

const TONE_TEXT: Readonly<Record<HeaderBarTone, string>> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  accent: "text-timeline-accent",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};

const TONE_DOT: Readonly<Record<HeaderBarTone, string>> = {
  default: "bg-foreground",
  muted: "bg-muted-foreground/60",
  accent: "bg-timeline-accent",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

const TASK_STATUS_COLOR: Readonly<Record<HeaderBarTaskStatus, string>> = {
  backlog: "text-muted-foreground",
  todo: "text-muted-foreground",
  in_progress: "text-attention",
  in_review: "text-timeline-accent",
  done: "text-success",
  canceled: "text-muted-foreground",
};

const PRIORITY_BARS: Readonly<Record<Exclude<HeaderBarTaskPriority, "urgent">, number>> = {
  low: 1,
  medium: 2,
  high: 3,
};

export function toneTextClass(tone: HeaderBarTone | undefined): string {
  return TONE_TEXT[tone ?? "default"];
}

export function StatusBarGlyph({
  glyph,
  className,
}: {
  readonly glyph: HeaderBarGlyph;
  readonly className?: string;
}) {
  switch (glyph.kind) {
    case "icon":
      return (
        <Icon
          name={glyph.name}
          aria-hidden
          className={cn("size-3.5 shrink-0", TONE_TEXT[glyph.tone ?? "muted"], className)}
        />
      );
    case "image":
      return (
        <img
          src={glyph.src}
          alt={glyph.alt ?? ""}
          aria-hidden={glyph.alt ? undefined : true}
          className={cn("size-3.5 shrink-0 rounded-xs object-cover", className)}
        />
      );
    case "dot":
      return (
        <span
          aria-hidden
          className={cn(
            "inline-block size-1.5 shrink-0 rounded-full",
            TONE_DOT[glyph.tone],
            glyph.pulse && "animate-pulse motion-reduce:animate-none",
            className,
          )}
        />
      );
    case "task-status":
      return <TaskStatusGlyph status={glyph.status} className={className} />;
    case "task-priority":
      return <TaskPriorityGlyph priority={glyph.priority} className={className} />;
  }
}

function TaskStatusGlyph({
  status,
  className,
}: {
  readonly status: HeaderBarTaskStatus;
  readonly className?: string;
}) {
  const ring = (dashed: boolean) => (
    <circle
      cx="7"
      cy="7"
      r="5.4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      {...(dashed ? { strokeDasharray: "1.8 2" } : {})}
    />
  );
  const disc = <circle cx="7" cy="7" r="6" fill="currentColor" />;
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      data-status-icon={status}
      className={cn("size-3.5 shrink-0", TASK_STATUS_COLOR[status], className)}
    >
      {status === "backlog" ? ring(true) : null}
      {status === "todo" ? ring(false) : null}
      {status === "in_progress" ? (
        <>
          {ring(false)}
          <path d="M7 7 L7 2.4 A4.6 4.6 0 0 1 11.2 9.5 Z" fill="currentColor" />
        </>
      ) : null}
      {status === "in_review" ? (
        <>
          <path
            d="M7 1.5 12.5 7 7 12.5 1.5 7Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            fill="none"
          />
          <circle cx="7" cy="7" r="1.65" fill="currentColor" />
        </>
      ) : null}
      {status === "done" ? (
        <>
          {disc}
          <path
            d="M4.4 7.2 l1.8 1.8 3.4-3.8"
            fill="none"
            stroke="var(--background)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      ) : null}
      {status === "canceled" ? (
        <>
          {disc}
          <path
            d="M5 5 l4 4 M9 5 l-4 4"
            stroke="var(--background)"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </>
      ) : null}
    </svg>
  );
}

function TaskPriorityGlyph({
  priority,
  className,
}: {
  readonly priority: HeaderBarTaskPriority;
  readonly className?: string;
}) {
  if (priority === "urgent") {
    return (
      <svg
        viewBox="0 0 14 14"
        aria-hidden
        data-priority-icon={priority}
        className={cn("size-3.5 shrink-0 text-warning", className)}
      >
        <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill="currentColor" />
        <rect x="6.2" y="3" width="1.6" height="5.2" rx="0.8" fill="var(--background)" />
        <circle cx="7" cy="10.6" r="1" fill="var(--background)" />
      </svg>
    );
  }
  const active = PRIORITY_BARS[priority];
  const bars = [
    { x: 1.5, y: 8, height: 5 },
    { x: 5.5, y: 5, height: 8 },
    { x: 9.5, y: 2, height: 11 },
  ];
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      data-priority-icon={priority}
      className={cn("size-3.5 shrink-0", className)}
    >
      {bars.map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width="3"
          height={bar.height}
          rx="1"
          className={index < active ? "fill-muted-foreground" : "fill-muted"}
        />
      ))}
    </svg>
  );
}
