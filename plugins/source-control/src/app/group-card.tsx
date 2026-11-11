/**
 * Several Changes an agent shared as one card: each one's own card, then
 * Ship all, which asks the thread's agent to ship them, and Merge all once
 * every one is a pull request ready to merge. Ported from code-review's
 * grouped Review card (`src/app/review-embed.tsx`). Merge all does not ask
 * the agent: it merges each pull request in card order, pinned to the head
 * and base shown when the reader chose it, and stops at the first that does
 * not merge.
 */
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GroupEntry } from "../core/directive.ts";
import type { ChangeKey } from "../core/ids.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { ChangeCard, useSeen } from "./chat-card.tsx";
import { plural } from "./format.ts";
import { mergeAll, mergeAllText } from "./merge-all.ts";
import { mergeTarget, readyToMerge, useChangeMerge, type MergeTarget } from "./merge.tsx";
import { Button, Pending } from "./ui.tsx";

/** One place on the card: a Change, or a note for a target that did not resolve. */
export type GroupItem = { id: string; entry: GroupEntry } | { id: string; note: ReactNode };

const FOOTER =
  "flex w-full max-w-[576px] min-w-0 flex-col gap-2 rounded-[8px] border border-solid border-border bg-background px-3 py-2 text-[12px] leading-4 text-foreground";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Every pull request on the card, as it reads now, when all of them are ready to merge. */
function useMergeTargets(keys: readonly ChangeKey[], enabled: boolean): MergeTarget[] | null {
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "changeDetail",
    keys,
    enabled: enabled && keys.length > 0,
  });
  const data = query.data;
  return useMemo(() => {
    if (keys.length < 2) return null;
    const targets: MergeTarget[] = [];
    for (const key of keys) {
      const detail = data?.[key];
      if (detail?.state !== "change" || !readyToMerge(detail)) return null;
      const target = mergeTarget(detail);
      if (!target) return null;
      targets.push(target);
    }
    return targets;
  }, [keys, data]);
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
  const rpc = useRpc<typeof sourceControlContract>();
  const merge = useChangeMerge();
  const [confirming, setConfirming] = useState<MergeTarget[] | null>(null);
  const [running, setRunning] = useState<{ index: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const run = async (targets: MergeTarget[]) => {
    setConfirming(null);
    setOutcome(null);
    setRunning({ index: 0, total: targets.length });
    const result = await mergeAll(targets, {
      policy: (target) => rpc.call("mergePolicy", { key: target.changeKey, number: target.number }),
      merge,
      wait,
      onStart: (index) => setRunning({ index, total: targets.length }),
    });
    setRunning(null);
    setOutcome(mergeAllText(result));
  };
  return { confirming, setConfirming, running, outcome, run };
}

function GroupFooter({
  threadId,
  entries,
  targets,
}: {
  threadId: string;
  entries: readonly GroupEntry[];
  targets: MergeTarget[] | null;
}) {
  const ship = useShipAll(threadId, entries);
  const merging = useMergeAll();
  const cancel = useRef<HTMLButtonElement>(null);
  const confirmingNow = merging.confirming !== null;
  // The confirm step takes focus, so the keyboard lands on Cancel, not on a merge.
  useEffect(() => {
    if (confirmingNow) cancel.current?.focus();
  }, [confirmingNow]);
  const busy = ship.pending || merging.running !== null;
  const { confirming } = merging;
  return (
    <div className={FOOTER} data-testid="sc-group-footer">
      {confirming ? (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="m-0 text-muted-foreground">
            Merge {confirming.map((target) => `#${target.number}`).join(", ")} one at a time, each
            at the head shown here. It stops at the first that does not merge.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button ref={cancel} onClick={() => merging.setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              data-testid="sc-group-merge-confirm"
              onClick={() => void merging.run(confirming)}
            >
              Merge {confirming.length}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            className="min-w-0 flex-[1_1_8rem]"
            data-testid="sc-group-ship"
            disabled={busy || entries.length === 0}
            onClick={() => void ship.send()}
          >
            <Pending pending={ship.pending} icon="Sent" />
            Ship all {entries.length}
          </Button>
          {targets ? (
            <Button
              variant="primary"
              className="min-w-0 flex-[1_1_8rem]"
              data-testid="sc-group-merge"
              disabled={busy}
              // The run keeps the heads and bases seen now, whatever arrives meanwhile.
              onClick={() => merging.setConfirming(targets)}
            >
              <Pending pending={merging.running !== null} icon="GitMerge" />
              {merging.running
                ? `Merging ${merging.running.index + 1} of ${merging.running.total}`
                : `Merge all ${targets.length}`}
            </Button>
          ) : null}
        </div>
      )}
      {ship.sent ? <output className="m-0 block text-muted-foreground">{ship.sent}</output> : null}
      {merging.outcome ? (
        <output className="m-0 block text-muted-foreground" data-testid="sc-group-merge-outcome">
          {merging.outcome}
        </output>
      ) : null}
    </div>
  );
}

/** The grouped card: a count, each Change's card, then Ship all and Merge all. */
export function ChangeGroup({
  items,
  threadId,
}: {
  items: readonly GroupItem[];
  threadId: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const entries = useMemo(
    () => items.flatMap((item) => ("entry" in item ? [item.entry] : [])),
    [items],
  );
  const keys = useMemo(() => entries.map((entry) => entry.key), [entries]);
  // Every pull request must be ready, unresolved targets included: Merge all never merges part of a card silently.
  const visible = useSeen(root);
  const targets = useMergeTargets(keys, visible && entries.length === items.length);
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
      <GroupFooter threadId={threadId} entries={entries} targets={targets} />
    </section>
  );
}
