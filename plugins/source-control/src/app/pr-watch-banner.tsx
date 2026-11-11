/**
 * The pull requests a thread's agent watches with `source_control_watch_pr`,
 * as a card above the thread's composer: each one's checks at a glance, its
 * check list on demand, and Unwatch. Ported from code-review
 * (`src/app/pr-watch.tsx`). The server's poller is the only reader of GitHub;
 * the banner reads the stored watches, again only when the server says they
 * changed. With nothing watched it renders nothing, and bb hides its card.
 *
 * A composer banner has no visibility hook, so it mounts for every thread's
 * composer: one keyed, tag-invalidated read of a store row, cached per thread.
 */
import {
  experimental_Icon as Icon,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  UrlLink,
  useComposer,
} from "@get-bb/plugin-sdk/app";
import { useId, useMemo, useState } from "react";
import { prKey, type PrWatchView, type WatchCheck } from "../core/watch.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { cx, plural, shortAge, shortId } from "./format.ts";
import { CheckIcon } from "./page/icons.tsx";
import { useNow } from "./page/hooks.ts";

const NO_WATCHES: PrWatchView[] = [];

const ACTION =
  "inline-flex h-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-0 bg-transparent text-muted-foreground hover:bg-surface-raised hover:text-foreground focus-visible:outline-1 disabled:opacity-50";

type CheckState = WatchCheck["state"];

const count = (watch: PrWatchView, state: CheckState) =>
  watch.checks.checks.filter((check) => check.state === state).length;

/** The head's checks as one state, worst first: failed, running, cancelled, else passed. */
export function watchChecksState(watch: PrWatchView): CheckState | null {
  const { checks } = watch.checks;
  if (checks.length === 0) return null;
  for (const state of ["failure", "pending", "cancelled"] as const)
    if (checks.some((check) => check.state === state)) return state;
  return "success";
}

/** The failing check by name, "4/9 checks done", "1 cancelled", or "Checks passed". */
export function watchOutcome(watch: PrWatchView): string {
  if (watch.state === "merged") return "Merged";
  if (watch.state === "closed") return "Closed";
  const total = watch.checks.checks.length;
  if (total === 0) return "No checks yet";
  const [failed, ...moreFailed] = watch.checks.checks.filter((check) => check.state === "failure");
  if (failed)
    return moreFailed.length > 0
      ? `${failed.name} and ${moreFailed.length} more failing`
      : `${failed.name} failing`;
  const running = count(watch, "pending");
  if (running > 0) return `${total - running}/${total} checks done`;
  const cancelled = count(watch, "cancelled");
  return cancelled > 0 ? `${cancelled} cancelled` : "Checks passed";
}

/** The merge state, when it blocks an open pull request. */
function mergeNote(watch: PrWatchView): string | null {
  if (watch.state !== "open") return null;
  if (watch.mergeState === "DIRTY") return "Conflicts";
  if (watch.mergeState === "BEHIND") return "Behind base";
  return null;
}

/** The outcome, then the merge state when it blocks: "lint failing · Behind base". */
export function watchSummary(watch: PrWatchView): string {
  return [watchOutcome(watch), mergeNote(watch)].filter(Boolean).join(" · ");
}

const OUTCOME: Record<CheckState, "passed" | "failed" | "pending" | "skipped"> = {
  success: "passed",
  failure: "failed",
  pending: "pending",
  neutral: "skipped",
  skipped: "skipped",
  cancelled: "skipped",
};

/** The composer banner. Only a thread's own composer has watches to show. */
export function PrWatchBanner() {
  const { scope } = useComposer();
  return scope.kind === "thread" ? <PrWatchCard threadId={scope.threadId} /> : null;
}

function PrWatchCard({ threadId }: { threadId: string }) {
  const keys = useMemo(() => [threadId], [threadId]);
  // Keyed, so switching back to a thread reads nothing until its watches change.
  const query = useRpcKeyedQuery({ contract: sourceControlContract, method: "prWatches", keys });
  const watches = query.data?.[threadId]?.watches ?? NO_WATCHES;
  if (watches.length === 0) return null;
  return (
    <section
      aria-label="Watched pull requests"
      data-bb-plugin="source-control"
      data-testid="sc-pr-watch"
      className="flex flex-col p-1 text-[12px]"
    >
      {watches.map((watch) => (
        <WatchedPullRequest key={prKey(watch.ref)} threadId={threadId} watch={watch} />
      ))}
    </section>
  );
}

function StateIcon({ watch }: { watch: PrWatchView }) {
  if (watch.state !== "open")
    return (
      <Icon
        name={watch.state === "merged" ? "GitMerge" : "GitPullRequestClosed"}
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
    );
  const state = watchChecksState(watch);
  return state ? (
    <CheckIcon outcome={OUTCOME[state]} />
  ) : (
    <Icon name="GitPullRequest" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
  );
}

function WatchedPullRequest({ threadId, watch }: { threadId: string; watch: PrWatchView }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const stop = useRpcMutation({ contract: sourceControlContract, method: "stopPrWatch" });
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
          className={cx(
            "flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-[4px] border-0 bg-transparent px-2 py-1 text-start hover:bg-surface-raised focus-visible:outline-1",
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
            className={cx(
              "ms-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </button>
        <UrlLink
          href={watch.url}
          className={cx(ACTION, "size-6")}
          aria-label={`Open ${key} on GitHub`}
          title="Open on GitHub"
        >
          <Icon name="ArrowUpRight" className="size-3.5" aria-hidden />
        </UrlLink>
        <button
          type="button"
          className={cx(ACTION, "px-1.5 text-[12px]")}
          aria-label={`Unwatch ${key}`}
          title="Stop watching. The agent is not told."
          disabled={stop.isPending}
          onClick={() => void stop.mutate({ threadId, ref: watch.ref }).catch(() => undefined)}
        >
          Unwatch
        </button>
      </div>
      {stop.error ? (
        <p className="m-0 px-2 pb-1 text-[11px] text-destructive-text">{stop.error.message}</p>
      ) : null}
      {expanded ? <WatchDetails id={listId} watch={watch} /> : null}
    </div>
  );
}

function WatchDetails({ id, watch }: { id: string; watch: PrWatchView }) {
  const now = useNow();
  const key = prKey(watch.ref);
  const notes = [
    `head ${shortId(watch.checks.headRefOid)}`,
    watch.mergeState === "DIRTY" ? "conflicts with base" : null,
    watch.mergeState === "BEHIND" ? "behind base" : null,
    watch.ended ? "watch ended" : null,
    `read ${shortAge(watch.polledAt, Math.max(now, Date.parse(watch.polledAt)))}`,
  ].filter(Boolean);
  const { checks } = watch.checks;
  return (
    <div id={id} className="flex min-w-0 flex-col pb-1">
      <p className="m-0 min-w-0 truncate ps-2 text-[11px] text-muted-foreground" translate="no">
        {notes.join(" · ")}
      </p>
      {watch.error ? (
        <p className="m-0 flex min-w-0 items-center gap-1 px-2 text-[11px] text-warning">
          <Icon name="AlertTriangle" className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate" title={watch.error}>
            Last read failed: {watch.error}
          </span>
        </p>
      ) : null}
      {checks.length === 0 ? (
        <p className="m-0 px-2 py-1 text-[11px] text-muted-foreground">
          No checks reported for this commit yet.
        </p>
      ) : (
        <ul
          className="m-0 mt-1 flex max-h-56 list-none flex-col gap-px overflow-y-auto p-0"
          aria-label={`${plural(checks.length, "check")} on ${key}`}
        >
          {checks.map((check) => (
            <li
              key={check.id}
              className={cx(
                "flex min-w-0 items-center gap-1.5 rounded-[4px] px-2 py-0.5",
                check.state === "failure" &&
                  "bg-[color-mix(in_oklab,var(--destructive)_10%,transparent)]",
              )}
            >
              <CheckIcon outcome={OUTCOME[check.state]} />
              <span
                className={cx(
                  "min-w-0 flex-1 truncate",
                  check.state === "failure" ? "text-foreground" : "text-muted-foreground",
                )}
                title={check.name}
              >
                {check.name}
              </span>
              {check.detailsUrl ? (
                <UrlLink
                  href={check.detailsUrl}
                  className={cx(ACTION, "size-5")}
                  aria-label={`Details for ${check.name}`}
                  title="Open the run's details"
                >
                  <Icon name="ArrowUpRight" className="size-3.5" aria-hidden />
                </UrlLink>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
