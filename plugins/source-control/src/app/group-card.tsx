/**
 * Several Changes an agent shared as one card: each one's own card, then
 * Ship all, which asks the thread's agent to ship those not yet merged, and
 * Merge all once each of those is a pull request ready to merge. Once every
 * pull request has merged the card says so and offers neither. Ported from
 * code-review's grouped Review card (`src/app/review-embed.tsx`). Merge all
 * does not ask the agent: it merges each pull request in card order, pinned
 * to the head and base shown when the reader chose it, and stops at the first
 * that does not merge.
 */
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GroupEntry } from "../core/directive.ts";
import type { ChangeDetail } from "../core/review.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { ChangeCard, useSeen } from "./chat-card.tsx";
import { plural } from "./format.ts";
import { mergeAll, mergeAllText } from "./merge-all.ts";
import { mergeTarget, readyToMerge, useChangeMerge, type MergeTarget } from "./merge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { Pending } from "./ui.tsx";

/** One place on the card: a Change, or a note for a target that did not resolve. */
export type GroupItem = { id: string; entry: GroupEntry } | { id: string; note: ReactNode };

const FOOTER =
  "flex w-full max-w-[576px] min-w-0 flex-col gap-2 rounded-[8px] border border-solid border-border bg-background px-3 py-2 text-[12px] leading-4 text-foreground";

/** Where the card's pull requests stand, as each one's own card reads it now. */
type GroupStatus =
  | { kind: "reading" }
  | {
      kind: "read";
      total: number;
      merged: number;
      closed: number;
      /** Notes, and Changes bb could not read: Merge all cannot vouch for them. */
      unread: number;
      /** Neither merged nor closed: what Ship all asks the agent to ship. */
      remaining: GroupEntry[];
      /** The remaining pull requests, when every place on the card allows Merge all. */
      targets: MergeTarget[] | null;
    };

function groupStatus(
  items: readonly GroupItem[],
  details: Readonly<Record<string, ChangeDetail>> | undefined,
  readFailed: boolean,
): GroupStatus {
  let merged = 0;
  let closed = 0;
  let unread = 0;
  const remaining: GroupEntry[] = [];
  const targets: MergeTarget[] = [];
  let mergeable = true;
  for (const item of items) {
    if (!("entry" in item)) {
      unread += 1;
      continue;
    }
    const detail = details?.[item.entry.key];
    if (!detail || detail.state === "pending") {
      if (!readFailed) return { kind: "reading" };
      unread += 1;
    } else if (detail.state === "missing") unread += 1;
    else if (detail.row.state === "merged") merged += 1;
    else if (detail.row.state === "closed") closed += 1;
    else {
      remaining.push(item.entry);
      const target = readyToMerge(detail) ? mergeTarget(detail) : null;
      if (target) targets.push(target);
      else mergeable = false;
    }
  }
  return {
    kind: "read",
    total: items.length,
    merged,
    closed,
    unread,
    remaining,
    targets: mergeable && unread === 0 && targets.length > 0 ? targets : null,
  };
}

/** The card's pull requests, read like each card reads its own. */
function useGroupStatus(items: readonly GroupItem[], enabled: boolean): GroupStatus {
  const keys = useMemo(
    () => items.flatMap((item) => ("entry" in item ? [item.entry.key] : [])),
    [items],
  );
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "changeDetail",
    keys,
    enabled: enabled && keys.length > 0,
  });
  const failed = query.error !== null && query.error !== undefined;
  return useMemo(() => groupStatus(items, query.data, failed), [items, query.data, failed]);
}

/** "1 of 3 merged. 1 closed." for a card with work left or places it cannot read. */
function summaryText(status: Extract<GroupStatus, { kind: "read" }>): string {
  const parts: string[] = [];
  if (status.merged > 0) parts.push(`${status.merged} of ${status.total} merged.`);
  if (status.closed > 0) parts.push(`${status.closed} closed.`);
  if (status.unread > 0) parts.push(`${status.unread} could not be read.`);
  return parts.join(" ");
}

function useShipAll(threadId: string, entries: readonly GroupEntry[]) {
  const ship = useRpcMutation({ contract: sourceControlContract, method: "shipGroup" });
  const [sent, setSent] = useState<string | null>(null);
  const send = async () => {
    setSent(null);
    try {
      const result = await ship.mutate({ threadId, changes: [...entries] });
      setSent(result.ok ? "Asked the agent to ship them." : result.message);
    } catch (error) {
      setSent(error instanceof Error ? error.message : "The request failed.");
    }
  };
  return { send, pending: ship.isPending, sent };
}

/** Merge all: an inline confirm, then each pull request in turn. */
function useMergeAll() {
  const merge = useChangeMerge();
  const [confirming, setConfirming] = useState<MergeTarget[] | null>(null);
  const [running, setRunning] = useState<{ index: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const run = async (targets: MergeTarget[]) => {
    setConfirming(null);
    setOutcome(null);
    setRunning({ index: 0, total: targets.length });
    const result = await mergeAll(targets, {
      merge,
      onStart: (index) => setRunning({ index, total: targets.length }),
    });
    setRunning(null);
    setOutcome(mergeAllText(result));
  };
  return { confirming, setConfirming, running, outcome, run };
}

type ShipAll = ReturnType<typeof useShipAll>;
type MergeAll = ReturnType<typeof useMergeAll>;

/** What the card can still do: reading, all merged, or Ship and Merge for what is left. */
function GroupActions({
  read,
  ship,
  merging,
}: {
  read: Extract<GroupStatus, { kind: "read" }>;
  ship: ShipAll;
  merging: MergeAll;
}) {
  const { remaining, targets, total } = read;
  if (read.merged === total)
    return (
      <p className="m-0 text-muted-foreground" data-testid="sc-group-landed">
        All {total} merged.
      </p>
    );
  // "all" while nothing on the card is done or unreadable, else only what is left.
  const scope = remaining.length === total ? "all" : "remaining";
  const busy = ship.pending || merging.running !== null;
  const summary = summaryText(read);
  return (
    <>
      {summary ? (
        <p className="m-0 text-muted-foreground" data-testid="sc-group-summary">
          {summary}
        </p>
      ) : null}
      {remaining.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 min-w-0 flex-[1_1_8rem]"
            data-testid="sc-group-ship"
            disabled={busy}
            onClick={() => void ship.send()}
          >
            <Pending pending={ship.pending} icon="Sent" />
            Ship {scope} {remaining.length}
          </Button>
          {targets ? (
            <Button
              size="sm"
              variant="default"
              className="h-7 min-w-0 flex-[1_1_8rem]"
              data-testid="sc-group-merge"
              disabled={busy}
              // The run keeps the heads and bases seen now, whatever arrives meanwhile.
              onClick={() => merging.setConfirming(targets)}
            >
              <Pending pending={merging.running !== null} icon="GitMerge" />
              {merging.running
                ? `Merging ${merging.running.index + 1} of ${merging.running.total}`
                : `Merge ${scope} ${targets.length}`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function GroupFooter({ threadId, status }: { threadId: string; status: GroupStatus }) {
  const ship = useShipAll(threadId, status.kind === "read" ? status.remaining : []);
  const merging = useMergeAll();
  const cancel = useRef<HTMLButtonElement>(null);
  const confirmingNow = merging.confirming !== null;
  // The confirm step takes focus, so the keyboard lands on Cancel, not on a merge.
  useEffect(() => {
    if (confirmingNow) cancel.current?.focus();
  }, [confirmingNow]);
  const { confirming } = merging;
  let body: ReactNode;
  if (confirming)
    body = (
      <div className="flex min-w-0 flex-col gap-2">
        <p className="m-0 text-muted-foreground">
          Merge {confirming.map((target) => `#${target.number}`).join(", ")} one at a time, each at
          the head shown here. It stops at the first that does not merge.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            className="h-7"
            variant="outline"
            ref={cancel}
            onClick={() => merging.setConfirming(null)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7"
            variant="default"
            data-testid="sc-group-merge-confirm"
            onClick={() => void merging.run(confirming)}
          >
            Merge {confirming.length}
          </Button>
        </div>
      </div>
    );
  else if (status.kind === "reading")
    body = (
      <div
        className="flex min-w-0 gap-2"
        aria-busy="true"
        aria-label="Reading these changes"
        data-testid="sc-group-reading"
      >
        <Skeleton className="h-7 flex-1" />
      </div>
    );
  else body = <GroupActions read={status} ship={ship} merging={merging} />;
  return (
    <div className={FOOTER} data-testid="sc-group-footer">
      {body}
      {ship.sent ? <output className="m-0 block text-muted-foreground">{ship.sent}</output> : null}
      {merging.outcome ? (
        <output className="m-0 block text-muted-foreground" data-testid="sc-group-merge-outcome">
          {merging.outcome}
        </output>
      ) : null}
    </div>
  );
}

/** The grouped card: a count, each Change's card, then Ship all and Merge all for what is left. */
export function ChangeGroup({
  items,
  threadId,
}: {
  items: readonly GroupItem[];
  threadId: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const visible = useSeen(root);
  const status = useGroupStatus(items, visible);
  return (
    <section
      ref={root}
      data-bb-plugin="source-control"
      data-testid="sc-group"
      aria-label={plural(items.length, "change")}
      className="my-2 flex w-full min-w-0 flex-col"
    >
      <span className="text-[12px] leading-4 font-medium text-muted-foreground">
        {plural(items.length, "change")}
      </span>
      {items.map((item) =>
        "entry" in item ? (
          <ChangeCard
            key={item.id}
            changeKey={item.entry.key}
            revision={item.entry.revision}
            threadId={threadId}
            grouped
          />
        ) : (
          <div key={item.id} className="my-2">
            {item.note}
          </div>
        ),
      )}
      <GroupFooter threadId={threadId} status={status} />
    </section>
  );
}
