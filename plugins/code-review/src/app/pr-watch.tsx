import { useEffect, useId, useRef, useState } from "react";
import {
  UrlLink,
  experimental_Icon as Icon,
  useBbNavigate,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import { queryClient } from "./query.ts";
import { PR_WATCH_CHANNEL, prKey, prSubPath } from "../shared/schema.ts";
import type { Check, PrWatch } from "../shared/schema.ts";
import { checkDuration } from "./checks.tsx";
import { CONTROL_HOVER_TRANSITION } from "./components/ui/motion.ts";
import { PANEL_PATH, plural, relativeTime, shortSha } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { errorText } from "./notice.tsx";
import { queryKey as rpcQueryKey, useRpcQuery, useRpcMutation } from "./rpc.ts";
import { ChecksStateIcon } from "./status.tsx";
import { useNow } from "./sync-state.tsx";

/*
 * The pull requests a thread's agent watches with `code_review_watch_pr`, as
 * a card above the thread's composer: each one's checks at a glance, and its
 * check list on demand. The server's poller is the only reader of GitHub, so
 * every open client shows the same read. With nothing watched the banner
 * renders nothing and bb hides its card.
 */

/** Realtime carries each change; the poll keeps "read 1m ago" moving and covers missed signals. */
const WATCHING_POLL_MS = 30_000;

const ACTION_CLASS = cn(
  "inline-flex h-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50",
  CONTROL_HOVER_TRANSITION,
);

export function usePrWatches(threadId: string) {
  const input = { threadId };
  const queryKey = rpcQueryKey("prWatches", input);
  const query = useRpcQuery("prWatches", input, {
    staleTime: 10_000,
    // A thread that watches nothing hears its first watch over realtime, or on reconnect.
    refetchInterval: (current) => (current.state.data?.watches.length ? WATCHING_POLL_MS : false),
  });
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previous.current !== "connected") {
      void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
    }
    previous.current = connection;
  }, [connection, queryKey]);
  useRealtime(PR_WATCH_CHANNEL, (payload) => {
    if (
      typeof payload === "object" &&
      payload !== null &&
      (payload as { threadId?: unknown }).threadId === threadId
    ) {
      void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
    }
  });
  return query;
}

/** The head's checks as one state, worst first: failed, running, cancelled, else passed. */
export function watchChecksState(watch: PrWatch): Check["state"] | null {
  const { checks } = watch.checks;
  if (checks.length === 0) return null;
  for (const state of ["failure", "pending", "cancelled"] as const) {
    if (checks.some((check) => check.state === state)) return state;
  }
  return "success";
}

const count = (watch: PrWatch, state: Check["state"]) =>
  watch.checks.checks.filter((check) => check.state === state).length;

/** The failing check by name, "4/9 checks done", "1 cancelled", or "Checks passed". */
function watchOutcome(watch: PrWatch): string {
  if (watch.state === "merged") return "Merged";
  if (watch.state === "closed") return "Closed";
  const total = watch.checks.checks.length;
  const running = count(watch, "pending");
  // The server lists failures first, so this names the first by name.
  const [failed, ...moreFailed] = watch.checks.checks.filter((check) => check.state === "failure");
  return total === 0
    ? "No checks yet"
    : failed
      ? moreFailed.length > 0
        ? `${failed.name} and ${moreFailed.length} more failing`
        : `${failed.name} failing`
      : running > 0
        ? `${total - running}/${total} checks done`
        : count(watch, "cancelled") > 0
          ? `${count(watch, "cancelled")} cancelled`
          : "Checks passed";
}

/** The merge state, when it blocks an open pull request. */
function mergeNote(watch: PrWatch): string | null {
  if (watch.state !== "open") return null;
  if (watch.mergeState === "DIRTY") return "Conflicts";
  if (watch.mergeState === "BEHIND") return "Behind base";
  return null;
}

/** The outcome, then the merge state when it blocks: "lint failing · Behind base". */
export function watchSummary(watch: PrWatch): string {
  return [watchOutcome(watch), mergeNote(watch)].filter(Boolean).join(" · ");
}

/** The composer banner. Only a thread's own composer has watches to show. */
export function PrWatchBanner() {
  const { scope } = useComposer();
  return scope.kind === "thread" ? <PrWatchCard threadId={scope.threadId} /> : null;
}

function PrWatchCard({ threadId }: { threadId: string }) {
  const watches = usePrWatches(threadId).data?.watches ?? [];
  if (watches.length === 0) return null;
  return (
    <section aria-label="Watched pull requests" className="flex flex-col p-1 text-xs">
      {watches.map((watch) => (
        <WatchedPullRequest key={prKey(watch.ref)} threadId={threadId} watch={watch} />
      ))}
    </section>
  );
}

function StateIcon({ watch }: { watch: PrWatch }) {
  if (watch.state !== "open") {
    return (
      <Icon
        name={watch.state === "merged" ? "GitMerge" : "GitPullRequestClosed"}
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
    );
  }
  const state = watchChecksState(watch);
  return state ? (
    <ChecksStateIcon state={state} />
  ) : (
    <Icon name="GitPullRequest" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
  );
}

function WatchedPullRequest({ threadId, watch }: { threadId: string; watch: PrWatch }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const stop = useRpcMutation("stopPrWatch", {
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: rpcQueryKey("prWatches", { threadId }) }),
  });
  const key = prKey(watch.ref);
  const summary = watchSummary(watch);
  const note = mergeNote(watch);
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-h-7 min-w-0 items-center gap-0.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={`${key} ${watch.title}: ${summary}. ${expanded ? "Hide" : "Show"} checks`}
          title={`${key} ${watch.title}: ${summary}`}
          onClick={() => setExpanded((current) => !current)}
          className={cn(
            "group/disclosure flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-start transition-colors hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
            expanded ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <StateIcon watch={watch} />
          <span className="flex min-w-0 font-medium text-foreground">
            <span className="min-w-0 truncate">{watchOutcome(watch)}</span>
            {note ? <span className="shrink-0 whitespace-pre"> · {note}</span> : null}
          </span>
          {/* The title gives way first; the outcome truncates only when it alone overflows. */}
          <span className="min-w-0 shrink-[100000] truncate">{watch.title}</span>
          <span className="shrink-0 tabular-nums" translate="no">
            #{watch.ref.number}
          </span>
          <Icon
            name="ChevronDown"
            className={cn(
              "ms-auto size-3.5 shrink-0 text-subtle-foreground transition-transform duration-200 motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </button>
        <UrlLink
          href={watch.url}
          className={cn(ACTION_CLASS, "size-6")}
          aria-label={`Open ${key} on GitHub`}
          title="Open on GitHub"
        >
          <Icon name="ArrowUpRight" className="size-3.5" aria-hidden />
        </UrlLink>
        <button
          type="button"
          className={cn(ACTION_CLASS, "px-1.5")}
          aria-label={`Unwatch ${key}`}
          title="Stop watching. The agent is not told."
          disabled={stop.isPending}
          onClick={() => stop.mutate({ threadId, ref: watch.ref })}
        >
          Unwatch
        </button>
      </div>
      {stop.isError ? (
        <p className="px-2 pb-1 text-[11px] text-destructive-text">{errorText(stop.error)}</p>
      ) : null}
      {expanded ? <WatchDetails id={listId} watch={watch} /> : null}
    </div>
  );
}

function WatchDetails({ id, watch }: { id: string; watch: PrWatch }) {
  const navigate = useBbNavigate();
  const now = useNow();
  const key = prKey(watch.ref);
  const notes = [
    `head ${shortSha(watch.checks.headRefOid)}`,
    watch.mergeState === "DIRTY" ? "conflicts with base" : null,
    watch.mergeState === "BEHIND" ? "behind base" : null,
    watch.ended ? "watch ended" : null,
    `read ${relativeTime(watch.polledAt, Math.max(now, Date.parse(watch.polledAt)))}`,
  ].filter(Boolean);
  const { checks } = watch.checks;
  return (
    <div id={id} className="flex min-w-0 flex-col pb-1">
      <div className="flex min-w-0 items-center gap-2 ps-2">
        <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" translate="no">
          {notes.join(" · ")}
        </p>
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded px-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() =>
            navigate.toPluginPanel(PANEL_PATH, {
              subPath: prSubPath(watch.ref, "checks", watch.account),
            })
          }
        >
          Open in Review
        </button>
      </div>
      {watch.error ? (
        <p className="flex min-w-0 items-center gap-1 px-2 text-[11px] text-warning-text">
          <Icon name="AlertTriangle" className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate" title={watch.error}>
            Last read failed: {watch.error}
          </span>
        </p>
      ) : null}
      {checks.length === 0 ? (
        <p className="px-2 py-1 text-[11px] text-subtle-foreground">
          No checks reported for this commit yet.
        </p>
      ) : (
        <ul
          className="mt-1 flex max-h-56 list-none flex-col gap-px overflow-y-auto"
          aria-label={`${plural(checks.length, "check")} on ${key}`}
        >
          {checks.map((check) => (
            <WatchedCheck key={check.id} check={check} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One line per check; a failure is tinted and carries its reason. */
function WatchedCheck({ check }: { check: Check }) {
  const duration = checkDuration(check);
  const failed = check.state === "failure";
  // A workflow named like its only job says nothing twice.
  const workflow = check.workflow === check.name ? null : check.workflow;
  return (
    <li
      className={cn(
        "flex min-w-0 items-start gap-1.5 rounded px-2 py-0.5",
        failed && "bg-surface-destructive",
      )}
    >
      <span className="flex h-5 shrink-0 items-center">
        <ChecksStateIcon state={check.state} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex h-5 min-w-0 items-center gap-1" title={check.name}>
          {/* A long workflow name gives way before the check's own name. */}
          {workflow ? (
            <span className="min-w-0 shrink-[100000] truncate text-muted-foreground" translate="no">
              {workflow} ›
            </span>
          ) : null}
          <span className={cn("truncate", failed ? "text-foreground" : "text-muted-foreground")}>
            {check.name}
          </span>
        </span>
        {failed && check.description ? (
          <span className="pb-0.5 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
            {check.description}
          </span>
        ) : null}
      </span>
      {duration ? (
        <span
          className="flex h-5 shrink-0 items-center text-[11px] tabular-nums text-subtle-foreground"
          title="Duration"
        >
          {duration}
        </span>
      ) : null}
      {check.detailsUrl ? (
        <UrlLink
          href={check.detailsUrl}
          className={cn(ACTION_CLASS, "size-5")}
          aria-label={`Details for ${check.name}`}
          title="Open the run's details"
        >
          <Icon name="ArrowUpRight" className="size-3.5" aria-hidden />
        </UrlLink>
      ) : null}
    </li>
  );
}
