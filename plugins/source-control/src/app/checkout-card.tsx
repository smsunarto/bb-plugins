/**
 * The card for `::source-control{path branch}`: work an agent names by where
 * it is, in a checkout or on a branch other than the one bb placed its thread
 * on. The server reads that path on the thread's own host. A Change bb can
 * open (a listed checkout has it, or it has a pull request) is that Change's
 * card; a branch only this checkout knows shows as a branch to ship.
 */
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import { useMemo, useRef, type ReactNode } from "react";
import { describeProblem, type ThreadChange } from "../core/change.ts";
import { checkoutWorkKey } from "../core/checkout-work.ts";
import { canShip, changeState, hasWork, summarize, type ChangeSummary } from "../core/status.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import {
  BranchGlyph,
  CARD,
  CardNote,
  CardSkeleton,
  ChangeCard,
  statusChip,
  useSeen,
} from "./chat-card.tsx";
import { cx, plural } from "./format.ts";
import { Quiet, ShipButton, threadShip, UncommittedCard, useShipThread } from "./thread-card.tsx";
import { Button } from "./components/ui/button.tsx";

/** A branch with commits that no listed checkout or pull request has: what it is, where, and Ship it. */
function BranchCard({
  summary,
  where,
  ship,
}: {
  summary: ChangeSummary;
  where: string;
  ship: ReturnType<typeof useShipThread>;
}) {
  const branch = summary.branch!;
  const chip = statusChip(changeState(summary));
  const commits = branch.commits.length + branch.moreCommits;
  return (
    <div className={CARD} data-testid="sc-card-branch">
      <div className="flex min-w-0 items-start gap-2 p-3">
        <BranchGlyph />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={cx(
                "flex h-4 shrink-0 items-center rounded-full px-2 text-[11px] leading-3 font-semibold",
                chip.className,
              )}
            >
              {chip.label}
            </span>
            <span className="min-w-0 truncate font-mono text-[11px] leading-4 text-(--tertiary-foreground)">
              {branch.name}
            </span>
            <span className="shrink-0 text-[11px] leading-4 text-(--tertiary-foreground)">
              {plural(commits, "commit")}
            </span>
          </div>
          <span className="min-w-0 text-[13px] leading-5 font-semibold break-words text-foreground">
            {branch.commits[0]?.subject ?? branch.name}
          </span>
          <span className="min-w-0 font-mono text-[11px] leading-4 break-all text-muted-foreground">
            {where}
          </span>
        </div>
      </div>
      {canShip(summary) ? (
        <div className="flex min-w-0 flex-wrap gap-2 px-3 pb-3">
          <ShipButton ship={ship} />
        </div>
      ) : null}
      {ship.sent ? (
        <output className="px-3 pb-3 text-[12px] leading-4 text-muted-foreground">
          {ship.sent}
        </output>
      ) : null}
    </div>
  );
}

type Checkout = Extract<ThreadChange, { state: "checkout" }>;

/** The card when the read cannot be drawn as work: why, or a placeholder while it loads. */
function Unread({
  row,
  offline,
  error,
  retry,
}: {
  row: Checkout | undefined;
  offline: boolean;
  error: Error | null;
  retry: () => void;
}) {
  if (row?.local.problem)
    return (
      <CardNote testId="sc-card-failed">
        <p role="alert" className="m-0 text-[13px] leading-5 text-muted-foreground">
          {offline ? "Offline." : describeProblem(row.local.problem)}
        </p>
      </CardNote>
    );
  if (error && !row)
    return (
      <CardNote testId="sc-card-failed">
        <p role="alert" className="m-0 text-[13px] leading-5 text-muted-foreground">
          Couldn't read this checkout. {error.message}
        </p>
        <div>
          <Button variant="outline" onClick={retry}>
            Try again
          </Button>
        </div>
      </CardNote>
    );
  return <CardSkeleton />;
}

/** Work only this checkout knows: its branch, else its uncommitted files, else nothing to ship. */
function LocalWork({
  summary,
  where,
  ship,
  stale,
}: {
  summary: ChangeSummary;
  where: string;
  ship: ReturnType<typeof useShipThread>;
  /** Why the read drawn here could not be renewed, when it could not. */
  stale: string | null;
}) {
  let body: ReactNode;
  if (summary.branch && hasWork(summary))
    body = <BranchCard summary={summary} where={where} ship={ship} />;
  else if (summary.uncommitted > 0)
    body = <UncommittedCard count={summary.uncommitted} ship={ship} where={where} />;
  else
    body = (
      <Quiet testId="sc-card-clean">
        Nothing left to ship: {where} is clean and this branch has no commits of its own.
      </Quiet>
    );
  return (
    <>
      {body}
      {stale ? (
        <span className="text-[12px] leading-4 text-muted-foreground" data-testid="sc-card-stale">
          {stale} This is what bb last read.
        </span>
      ) : null}
    </>
  );
}

export function CheckoutCard({
  threadId,
  path,
  branch,
}: {
  threadId: string;
  path: string | null;
  branch: string | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const visible = useSeen(root);
  const offline = useRealtimeConnectionState() !== "connected";
  const key = useMemo(() => checkoutWorkKey({ threadId, path, branch }), [threadId, path, branch]);
  const keys = useMemo(() => [key], [key]);
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "workAtCheckout",
    keys,
    enabled: visible,
  });
  const ship = useShipThread(threadId, key);
  const work = query.data?.[key];
  const row = work?.row;
  const summary = summarize(row);
  if (summary?.key && hasWork(summary) && work?.reviewable)
    return (
      <div ref={root} data-bb-plugin="source-control" className="flex w-full min-w-0">
        <ChangeCard
          changeKey={summary.key}
          revision={null}
          threadId={threadId}
          thread={threadShip(summary, ship)}
        />
      </div>
    );
  const checkout = row?.state === "checkout" ? row : undefined;
  const problem = checkout?.local.problem ?? null;
  let body: ReactNode;
  if (row?.state === "none") body = <Quiet testId="sc-card-none">{row.reason}</Quiet>;
  else if (summary && checkout)
    body = (
      <LocalWork
        summary={summary}
        where={`${checkout.placement.hostName}:${checkout.placement.path}`}
        ship={ship}
        stale={offline ? "Offline." : problem ? describeProblem(problem) : null}
      />
    );
  else
    body = (
      <Unread
        row={checkout}
        offline={offline}
        error={query.error ?? null}
        retry={() => void query.refetch()}
      />
    );
  return (
    <div
      ref={root}
      data-bb-plugin="source-control"
      className="@container my-2 flex w-full min-w-0 flex-col gap-1"
    >
      {body}
    </div>
  );
}
