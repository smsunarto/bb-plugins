/**
 * The card for `::source-control` with no key: this thread's work as it is
 * now. An agent writes it by hand, with no tool call, so it has no Change or
 * head of its own; the card takes both from the thread's row. A thread whose
 * branch has commits or a pull request shows that Change's card, with Ship
 * it while the branch has work to ship. One with no commits of its own shows
 * the checkout's uncommitted files instead. In a checkout several threads
 * share those may be another thread's, so they are counted only there.
 */
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { describeProblem } from "../core/change.ts";
import { canShip, hasWork, summarize } from "../core/status.ts";
import type { ChangeKey } from "../core/ids.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { CARD, CardNote, CardSkeleton, ChangeCard, useSeen } from "./chat-card.tsx";
import { cx, plural } from "./format.ts";
import { STATE_CHIP } from "./page/rail.tsx";
import { Button } from "./components/ui/button.tsx";
import { Pending } from "./ui.tsx";

/** Ship it: one message asking the thread's agent to commit and publish its work. */
function useShipThread(threadId: string) {
  const ship = useRpcMutation({ contract: sourceControlContract, method: "shipThread" });
  const [sent, setSent] = useState<string | null>(null);
  const send = async () => {
    setSent(null);
    try {
      const result = await ship.mutate({ threadId });
      setSent(result.ok ? "Asked the agent to ship it." : result.message);
    } catch (error) {
      setSent(error instanceof Error ? error.message : "The request failed.");
    }
  };
  return { send, pending: ship.isPending, sent };
}

/** What a thread's card adds to its Change's: Ship it, while its branch has work to ship. */
export type ThreadShip = {
  /** Null when nothing is left to ship. */
  button: ReactNode;
  /** What the last Ship it came to. */
  sent: string | null;
};

const uncommittedLine = (count: number) => `${plural(count, "uncommitted file")} in this checkout`;

function ShipButton({ ship }: { ship: ReturnType<typeof useShipThread> }) {
  return (
    <Button
      variant="default"
      data-testid="sc-card-ship"
      disabled={ship.pending}
      onClick={() => void ship.send()}
      className="min-w-0 flex-[1_1_8rem] gap-2 px-3 font-semibold"
    >
      <Pending pending={ship.pending} icon="Sent" />
      Ship it
    </Button>
  );
}

function Quiet({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <span data-testid={testId} className="text-[12px] leading-4 text-muted-foreground">
      {children}
    </span>
  );
}

/** Uncommitted files and no branch of the thread's own yet: nothing to review, only to ship. */
function UncommittedCard({
  count,
  ship,
}: {
  count: number;
  ship: ReturnType<typeof useShipThread>;
}) {
  return (
    <div className={CARD} data-testid="sc-card-uncommitted">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 p-3">
        <span
          className={cx(
            "flex h-4 shrink-0 items-center rounded-full px-2 text-[11px] leading-3 font-semibold",
            STATE_CHIP.local.className,
          )}
        >
          Uncommitted
        </span>
        <span className="min-w-0 text-[13px] leading-5 font-semibold break-words text-foreground">
          {uncommittedLine(count)}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap gap-2 px-3 pb-3">
        <ShipButton ship={ship} />
      </div>
      {ship.sent ? (
        <output className="px-3 pb-3 text-[12px] leading-4 text-muted-foreground">
          {ship.sent}
        </output>
      ) : null}
    </div>
  );
}

/** The ship slot for the thread's own Change: Ship it while its branch has work left. */
function threadShip(
  summary: NonNullable<ReturnType<typeof summarize>>,
  ship: ReturnType<typeof useShipThread>,
): ThreadShip {
  return {
    button: canShip(summary) ? <ShipButton ship={ship} /> : null,
    sent: ship.sent,
  };
}

/**
 * A keyed card (`::source-control{key}`, from the share tool) gets the same
 * Ship it as the hand-written one when its Change is still this thread's own
 * branch. The thread read is the composer strip's, so it costs no new read.
 */
export function OwnChangeCard({
  changeKey,
  revision,
  threadId,
}: {
  changeKey: ChangeKey;
  revision: string | null;
  threadId: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const visible = useSeen(root);
  const keys = useMemo(() => [threadId], [threadId]);
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "changeForThread",
    keys,
    enabled: visible,
  });
  const ship = useShipThread(threadId);
  const summary = summarize(query.data?.[threadId]);
  const own = summary !== null && summary.key === changeKey;
  return (
    <div ref={root} data-bb-plugin="source-control" className="flex w-full min-w-0">
      <ChangeCard
        changeKey={changeKey}
        revision={revision}
        threadId={threadId}
        thread={own ? threadShip(summary, ship) : null}
      />
    </div>
  );
}

export function ThreadCard({ threadId }: { threadId: string }) {
  const root = useRef<HTMLDivElement>(null);
  const visible = useSeen(root);
  const connection = useRealtimeConnectionState();
  const keys = useMemo(() => [threadId], [threadId]);
  // The composer strip's read of the same thread: one read serves both.
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "changeForThread",
    keys,
    enabled: visible,
  });
  const ship = useShipThread(threadId);
  const row = query.data?.[threadId];
  const summary = summarize(row);
  let body: ReactNode;
  if (row?.state === "none")
    body = <Quiet testId="sc-card-none">This thread has no checkout to show changes from.</Quiet>;
  // A thread with a branch is that Change's card, which brings its own frame and reads. A branch
  // with no commits yet, such as a checked-out main, has nothing to review: only files to ship.
  else if (summary?.key && hasWork(summary))
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
  else if (summary && summary.uncommitted > 0)
    body = <UncommittedCard count={summary.uncommitted} ship={ship} />;
  else if (summary)
    body = (
      <Quiet testId="sc-card-clean">
        Nothing left to ship: this thread's checkout is clean and has no commits of its own.
      </Quiet>
    );
  else if (row?.state === "checkout" && row.local.problem)
    body = (
      <CardNote testId="sc-card-failed">
        <p role="alert" className="m-0 text-[13px] leading-5 text-muted-foreground">
          {connection === "connected" ? describeProblem(row.local.problem) : "Offline."}
        </p>
      </CardNote>
    );
  else if (query.error && !row)
    body = (
      <CardNote testId="sc-card-failed">
        <p role="alert" className="m-0 text-[13px] leading-5 text-muted-foreground">
          Couldn't read this thread's changes. {query.error.message}
        </p>
        <div>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      </CardNote>
    );
  else body = <CardSkeleton />;
  return (
    <div ref={root} data-bb-plugin="source-control" className="@container my-2 flex w-full min-w-0">
      {body}
    </div>
  );
}
