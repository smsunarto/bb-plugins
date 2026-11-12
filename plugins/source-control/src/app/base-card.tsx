/**
 * The target branch under the workspace: the common base the applied branches
 * meet the target at, and the target's history below it. Ported from
 * gitbutler (`src/app/workspace-lane.tsx` `BaseCard`). The base comes from the
 * workspace read the tab already has; the history below it is read from the
 * checkout's host only once the reader opens the card, and once per base,
 * since history under a commit never changes.
 */
import {
  experimental_Icon as Icon,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { describeProblem, type Target } from "../core/change.ts";
import { BASE_HISTORY_MAX, BASE_HISTORY_PAGE, type BaseCommit } from "../core/history.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { absoluteTime, cx, shortAge, shortId } from "./format.ts";
import { Button } from "./components/ui/button.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";

/**
 * How many commits to list. The window belongs to the base it was opened on:
 * a new base is a different history, so it starts over at one page.
 */
function useHistoryWindow(from: string) {
  const [page, setPage] = useState({ from, limit: BASE_HISTORY_PAGE });
  const limit = page.from === from ? page.limit : BASE_HISTORY_PAGE;
  const grow = () =>
    setPage({ from, limit: Math.min(BASE_HISTORY_MAX, limit + BASE_HISTORY_PAGE) });
  return { limit, grow };
}

function CommitRow({ commit, now }: { commit: BaseCommit; now: number }) {
  return (
    <li
      className="flex min-w-0 items-center gap-2 border-t border-border-hairline px-3 py-1.5 first:border-t-0"
      data-testid="sc-base-commit"
    >
      <span
        className="min-w-0 flex-1 truncate text-[12px] leading-4 text-foreground"
        title={commit.subject}
      >
        {commit.subject || "(no message)"}
      </span>
      <code
        className="shrink-0 font-mono text-[11px] leading-4 text-muted-foreground"
        translate="no"
      >
        {shortId(commit.id)}
      </code>
      <time
        className="shrink-0 text-[11px] leading-4 text-muted-foreground tabular-nums"
        dateTime={commit.createdAt}
        title={absoluteTime(commit.createdAt)}
      >
        {shortAge(commit.createdAt, now)}
      </time>
    </li>
  );
}

function History({ threadId, from, now }: { threadId: string; from: string; now: number }) {
  const { limit, grow } = useHistoryWindow(from);
  const query = useRpcQuery({
    contract: sourceControlContract,
    method: "baseHistory",
    input: { threadId, from, limit },
  });
  // A longer page is a new read: the shorter list stays until it lands.
  const [shown, setShown] = useState<{ from: string; commits: BaseCommit[] } | null>(null);
  const answer = query.data;
  const fresh = answer?.ok ? answer.value.commits : null;
  if (fresh && (shown?.from !== from || shown.commits !== fresh))
    setShown({ from, commits: fresh });
  const commits = fresh ?? (shown?.from === from ? shown.commits : null);
  if (answer && !answer.ok)
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2">
        <p className="m-0 min-w-0 flex-1 text-[12px] leading-4 text-muted-foreground">
          History unavailable. {describeProblem(answer.problem)}
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  if (!commits)
    return query.error ? (
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2">
        <p className="m-0 min-w-0 flex-1 text-[12px] leading-4 text-muted-foreground">
          History failed to load. {query.error.message}
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    ) : (
      <div className="flex flex-col gap-2 px-3 py-2" aria-busy="true" aria-label="Loading history">
        <Skeleton className="h-3.5 w-64 max-w-full" />
        <Skeleton className="h-3.5 w-56 max-w-full" />
        <Skeleton className="h-3.5 w-60 max-w-full" />
      </div>
    );
  const more = answer?.ok === true && answer.value.hasMore && limit < BASE_HISTORY_MAX;
  return (
    <>
      {commits.length === 0 ? (
        <p className="m-0 px-3 py-2 text-[12px] leading-4 text-muted-foreground">
          Nothing before the common base.
        </p>
      ) : (
        <ul className="m-0 list-none p-0" aria-label="Before the common base">
          {commits.map((commit) => (
            <CommitRow key={commit.id} commit={commit} now={now} />
          ))}
        </ul>
      )}
      {more || (fresh === null && commits.length > 0) ? (
        <div className="border-t border-border-hairline px-3 py-2">
          <Button
            variant="outline"
            disabled={fresh === null}
            aria-busy={fresh === null}
            onClick={grow}
          >
            Show earlier commits
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** A folded card under the branches: the common base, and the target's history on request. */
export function BaseCard({
  threadId,
  target,
  now,
  className,
}: {
  threadId: string;
  target: Target & { base: NonNullable<Target["base"]> };
  now: number;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  const { base } = target;
  return (
    <section className={className} aria-label="Common base" data-testid="sc-base-card">
      <header className="flex min-h-10 min-w-0 items-center px-3 py-2">
        <button
          type="button"
          className="flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[4px] border-0 bg-transparent p-0 text-start"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon
            name="ChevronDown"
            className={cx(
              "size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              !open && "-rotate-90",
            )}
            aria-hidden
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] leading-5 font-semibold text-foreground">
              Common base
            </span>
            <span className="flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground">
              <span className="min-w-0 truncate" title={base.subject}>
                {base.subject || "(no message)"}
              </span>
              <code className="shrink-0 font-mono" translate="no">
                · {shortId(base.id)} on {target.ref}
              </code>
              {target.lastFetched ? (
                <span className="shrink-0">· fetched {shortAge(target.lastFetched, now)}</span>
              ) : null}
            </span>
          </span>
        </button>
      </header>
      {open ? (
        <div className="border-t border-border-hairline">
          <p className="m-0 px-3 pt-2 pb-1 text-[11px] leading-4 font-medium text-muted-foreground">
            Before the common base
          </p>
          <History threadId={threadId} from={base.id} now={now} />
        </div>
      ) : null}
    </section>
  );
}
