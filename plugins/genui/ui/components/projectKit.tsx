// Shared by the components that read the reply's thread's state from BB
// (Changes, Commits, Threads, Environments): the RPC query with its cache,
// snapshot refresh and visible-only polling, the panel frame, the freshness
// line and the one-line states.
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { relativeTime, type ProjectFailure } from "../../core/project";
import { IconButton } from "./iconButton";
import { RISE, useEntrance, type Entrance } from "./motion";
import { answerSignature, pollDelay } from "./project-logic";

/** The frame enters at once; only its rows are staggered (as layout.tsx's Card). */
const FRAME_RISE: Entrance = { ...RISE, stagger: false };

/** The current time, re-read every `intervalMs` so relative times stay true. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Whether the element is on screen in a visible page: live components poll only then. */
export function useVisible<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [onScreen, setOnScreen] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const element = ref.current;
    const onVisibility = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    const observer = element === null ? null : new IntersectionObserver((entries) => setOnScreen(entries.some((entry) => entry.isIntersecting)));
    if (element !== null) observer?.observe(element);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
    };
  }, []);
  return [ref, onScreen && pageVisible];
}

export type Query<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly answer: T; readonly refreshing: boolean };

/** The last answer per query key, so a block BB remounts (scrolling, reloads of the timeline) shows it at once. */
const lastAnswers = new Map<string, unknown>();

function failed(cause: unknown): ProjectFailure {
  return { ok: false, reason: "unavailable", message: cause instanceof Error ? cause.message : String(cause) };
}

/**
 * One read of BB state through the plugin's RPCs. `read(refresh)` asks the
 * backend; `refresh` replaces a kept snapshot. While `live(answer)` holds and
 * the component is `visible`, the read repeats with backoff (project-logic
 * pollDelay). A refresh that fails keeps what is shown and says why.
 */
export function useProjectQuery<T extends { readonly ok: boolean }>(
  key: string,
  read: (refresh: boolean) => Promise<T>,
  { live, visible = false }: { live?: (answer: T) => boolean; visible?: boolean } = {},
): { query: Query<T>; refresh: () => Promise<void> } {
  const cached = lastAnswers.get(key) as T | undefined;
  const [state, setState] = useState<{ key: string; query: Query<T> }>(() => ({
    key,
    query: cached === undefined ? { status: "loading" } : { status: "ready", answer: cached, refreshing: false },
  }));
  if (state.key !== key) {
    setState({ key, query: cached === undefined ? { status: "loading" } : { status: "ready", answer: cached, refreshing: false } });
  }
  const reader = useRef(read);
  reader.current = read;
  const ask = useCallback(async (refresh: boolean): Promise<T> => {
    try {
      return await reader.current(refresh);
    } catch (cause) {
      return failed(cause) as unknown as T;
    }
  }, []);
  const show = useCallback(
    (answer: T) => {
      lastAnswers.set(key, answer);
      setState((current) => (current.key === key ? { key, query: { status: "ready", answer, refreshing: false } } : current));
    },
    [key],
  );

  useEffect(() => {
    let current = true;
    void ask(false).then((answer) => current && show(answer));
    return () => {
      current = false;
    };
  }, [ask, show]);

  const query = state.key === key ? state.query : { status: "loading" as const };
  const answer = query.status === "ready" ? query.answer : null;
  const polling = answer !== null && visible && live !== undefined && live(answer);
  const unchanged = useRef(0);
  const signature = answer === null ? "" : answerSignature(answer);
  const lastSignature = useRef(signature);
  if (lastSignature.current !== signature) {
    unchanged.current = 0;
    lastSignature.current = signature;
  }
  useEffect(() => {
    if (!polling) return;
    let current = true;
    const timer = setTimeout(() => {
      void ask(false).then((next) => {
        if (!current) return;
        if (answerSignature(next) === lastSignature.current) unchanged.current += 1;
        show(next);
      });
    }, pollDelay(unchanged.current));
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // Every answer, changed or not, schedules the next poll.
  }, [polling, answer, ask, show]);

  const refresh = useCallback(async () => {
    setState((current) =>
      current.key === key && current.query.status === "ready" ? { key, query: { ...current.query, refreshing: true } } : current,
    );
    const next = await ask(true);
    const shown = lastAnswers.get(key) as T | undefined;
    if (!next.ok && shown?.ok) {
      toast.error((next as unknown as ProjectFailure).message);
      setState((current) => (current.key === key && current.query.status === "ready" ? { key, query: { ...current.query, refreshing: false } } : current));
      return;
    }
    show(next);
  }, [ask, key, show]);

  return { query, refresh };
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY_CLOCK = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const EXACT_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" });

/**
 * When what is shown was read: "as of 10:42" for a kept snapshot (it no
 * longer follows the checkout), "updated 2 min ago" for live state, with a
 * Refresh that reads BB again.
 */
export function Freshness({
  at,
  stored,
  refreshing,
  onRefresh,
  now,
}: {
  at: number;
  stored: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  now: number;
}) {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  const label = stored ? `as of ${(sameDay ? CLOCK : DAY_CLOCK).format(at)}` : `updated ${relativeTime(at, now)}`;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground">
      <time dateTime={new Date(at).toISOString()} title={`${stored ? "Saved with this reply" : "Read from BB"} ${EXACT_TIME.format(at)}`} className="tabular-nums">
        {label}
      </time>
      <IconButton
        label={stored ? "Refresh: replace this snapshot with the current state" : "Refresh"}
        tooltip={stored ? "Replace this snapshot with the current state" : "Refresh"}
        disabled={refreshing}
        onClick={onRefresh}
      >
        <Icon name="RotateCcw" aria-hidden className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
      </IconButton>
    </span>
  );
}

/** The bordered frame every Project component shares: a quiet header strip over its rows. */
export function Panel({ label, header, children }: { label: string; header: ReactNode; children: ReactNode }) {
  const rise = useEntrance<HTMLElement>(FRAME_RISE);
  return (
    <section ref={rise} aria-label={label} className="min-w-0 overflow-hidden rounded-lg border border-border bg-background text-sm text-foreground">
      <header className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface-recessed py-1 pl-3 pr-1 text-xs leading-5 text-muted-foreground">
        {header}
      </header>
      {children}
    </section>
  );
}

/** One quiet line saying what is true: empty, not available, needs a thread. */
export function QuietLine({ icon, children, className }: { icon?: string; children: ReactNode; className?: string }) {
  return (
    <p className={cn("m-0 flex min-w-0 items-start gap-2 text-xs leading-5 text-muted-foreground", className)}>
      {icon === undefined ? null : <Icon name={icon} aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}

/** A Project component outside any thread (the gallery without `?thread=`): what it would show. */
export function NeedsThread({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-dashed border-border px-3 py-3">
      <QuietLine icon={icon}>{children}</QuietLine>
    </div>
  );
}

/** Placeholder rows while BB answers. */
export function LoadingRows({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3 px-3 py-3">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-2">
          <Skeleton className="size-4 shrink-0 rounded-sm motion-reduce:animate-none" />
          <Skeleton className="h-3 rounded-sm motion-reduce:animate-none" style={{ width: `${[58, 42, 66, 50][index % 4]}%` }} />
        </div>
      ))}
    </div>
  );
}

/** "Show all 40 files" under a collapsed list. */
export function ShowAll({ count, noun, onClick }: { count: number; noun: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      className="h-auto w-full gap-1 rounded-none border-t border-border py-2 font-normal text-muted-foreground"
    >
      Show all {count} {noun}
      <Icon name="ChevronDown" aria-hidden />
    </Button>
  );
}

/** A failure BB reported, in the panel body. */
export function FailureLine({ failure }: { failure: ProjectFailure }) {
  return (
    <QuietLine icon={failure.reason === "not-git" || failure.reason === "no-environment" ? "FolderUnknown" : "AlertCircle"} className="px-3 min-h-10 py-2">
      {failure.message}
    </QuietLine>
  );
}
