/**
 * The card for `::source-control` with no key: this thread's work as it is
 * now. An agent writes it by hand, with no tool call, so it has no Change or
 * head of its own; the card takes both from the thread's row. A thread whose
 * branch has commits or a pull request shows that Change's card, with Ship
 * it while the branch has work to ship. One with no commits of its own and
 * only uncommitted files shows nothing: there is no Change to review yet.
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
import { CardNote, CardSkeleton, ChangeCard, useSeen } from "./chat-card.tsx";
import { cx } from "./format.ts";
import { CompactButton } from "./components/ui/button.tsx";
import { CARD_ACTION_CLASS, Pending } from "./ui.tsx";
import { AlertDescription } from "./components/ui/alert.tsx";

/**
 * Ship it: one message asking the thread's agent to commit and publish its
 * work, then settle the thread if nothing is left. `at` is the card's `workAtCheckout` key when it names a checkout or
 * branch other than the thread's own.
 */
export function useShipThread(threadId: string, at?: string) {
  const ship = useRpcMutation({ contract: sourceControlContract, method: "shipThread" });
  const [sent, setSent] = useState<string | null>(null);
  const send = async () => {
    setSent(null);
    try {
      const result = await ship.mutate(at === undefined ? { threadId } : { threadId, at });
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

export function ShipButton({ ship }: { ship: ReturnType<typeof useShipThread> }) {
  return (
    <CompactButton
      size="sm"
      variant="default"
      data-testid="sc-card-ship"
      disabled={ship.pending}
      onClick={() => void ship.send()}
      className={cx(CARD_ACTION_CLASS, "gap-2")}
    >
      <Pending pending={ship.pending} icon="Sent" />
      Ship it
    </CompactButton>
  );
}

export function Quiet({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <span data-testid={testId} className="text-[12px] leading-4 text-muted-foreground">
      {children}
    </span>
  );
}

/** The ship slot for the thread's own Change: Ship it while its branch has work left. */
export function threadShip(
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
  // Only uncommitted files: no Change to show yet. The root stays to keep the read live.
  else if (summary && summary.uncommitted > 0)
    return <div ref={root} data-bb-plugin="source-control" data-testid="sc-card-hidden" />;
  else if (summary)
    body = (
      <Quiet testId="sc-card-clean">
        Nothing left to ship: this thread's checkout is clean and has no commits of its own.
      </Quiet>
    );
  else if (row?.state === "checkout" && row.local.problem)
    body = (
      <CardNote testId="sc-card-failed">
        <AlertDescription>
          {connection === "connected" ? describeProblem(row.local.problem) : "Offline."}
        </AlertDescription>
      </CardNote>
    );
  else if (query.error && !row)
    body = (
      <CardNote testId="sc-card-failed">
        <AlertDescription>
          Couldn't read this thread's changes. {query.error.message}
        </AlertDescription>
        <div>
          <CompactButton size="sm" variant="outline" onClick={() => void query.refetch()}>
            Try again
          </CompactButton>
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
