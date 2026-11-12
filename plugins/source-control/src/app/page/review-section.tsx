/**
 * The rail's Review section (board A): every finding and comment on the
 * Change, grouped by author, each with the checkbox the diff's annotation
 * and the thread tab's card share. bb's group carries its review run's
 * state and the action that starts one.
 */
import {
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { memo, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { describeProblem } from "../../core/change.ts";
import type { ChangeKey } from "../../core/ids.ts";
import { groupItems, type ItemGroup, type ReviewItem, type ReviewRun } from "../../core/items.ts";
import { sourceControlContract } from "../../contract/rpc.ts";
import { cx, plural, shortAge } from "../format.ts";
import { useChangeReview, useReviewActions } from "../review-data.ts";
import {
  countLabel,
  itemTitle,
  latestBatch,
  placeLabel,
  sendableDrafts,
  type StableReview,
} from "../review-model.ts";
import {
  BotMark,
  Checkbox,
  FixingMark,
  PersonMark,
  PriorityChip,
  RunGlyph,
} from "../review-ui.tsx";
import { BatchBanner } from "../send.tsx";
import { SLOPCOP_PLUGIN_ID, slopCopContract, slopCopInput } from "../slopcop-contract.ts";
import { Button } from "../components/ui/button.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { useNow } from "./hooks.ts";
import { FocusContext, useIsFocused } from "./review-focus.ts";

const RAIL_LABEL =
  "m-0 text-[11px] leading-4 font-normal tracking-[0.06em] text-(--tertiary-foreground) uppercase";
const NOTE = "m-0 px-2 text-[12px] leading-4 text-muted-foreground";
const LINK =
  "shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[11px] leading-4 font-medium whitespace-nowrap text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-60";

// ── bb's run ───────────────────────────────────────────────────────────

type Started = { text: string; tone: "quiet" | "warning" } | null;

function RunStatus({ changeKey, run }: { changeKey: ChangeKey; run: ReviewRun | null }) {
  const start = useRpcMutation({ contract: sourceControlContract, method: "startReview" });
  const navigate = useBbNavigate();
  const [started, setStarted] = useState<Started>(null);
  const onStart = () => {
    setStarted(null);
    start.mutate({ key: changeKey }).then(
      (result) =>
        setStarted(
          result.ok
            ? { text: result.reused ? "Already reviewing" : "Review started", tone: "quiet" }
            : { text: result.message, tone: "warning" },
        ),
      (error: unknown) =>
        setStarted({
          text: error instanceof Error ? error.message : "Couldn't start the review.",
          tone: "warning",
        }),
    );
  };
  const action = (label: string) => (
    <button
      type="button"
      className={LINK}
      disabled={start.isPending}
      data-testid="sc-review-start"
      onClick={onStart}
    >
      {start.isPending ? "Starting…" : label}
    </button>
  );
  const open = run ? (
    <button
      type="button"
      className={LINK}
      onClick={() => navigate.toThread(run.threadId, { split: true })}
    >
      Open
    </button>
  ) : null;
  let status;
  if (!run || (started && started.tone === "warning"))
    status = (
      <>
        <span
          className={cx(
            "min-w-0 truncate text-[11px] leading-4",
            started?.tone === "warning" ? "text-warning" : "text-(--tertiary-foreground)",
          )}
        >
          {started?.text ?? "No review yet"}
        </span>
        {action(run ? "Run again" : "Review with bb")}
      </>
    );
  else if (run.state === "running")
    status = (
      <>
        <RunGlyph state="running" />
        <span className="min-w-0 truncate text-[11px] leading-4 text-warning">Reviewing…</span>
        {open}
      </>
    );
  else if (run.state === "failed")
    status = (
      <>
        <RunGlyph state="failed" />
        <span className="min-w-0 truncate text-[11px] leading-4 text-(--tertiary-foreground)">
          Failed
        </span>
        {open}
        {action("Run again")}
      </>
    );
  else
    status = (
      <>
        <RunGlyph state="done" />
        <span className="min-w-0 truncate text-[11px] leading-4 text-(--tertiary-foreground)">
          {plural(run.findings, "finding")}
        </span>
        {open}
        {action("Run again")}
      </>
    );
  return (
    <span className="flex min-w-0 items-center gap-2" data-testid="sc-review-run">
      {status}
    </span>
  );
}

// ── SlopCop's run ──────────────────────────────────────────────────────

type SlopCopInput = { repo: string; number: number };

/** SlopCop's state for the pull request; null when SlopCop is not installed or did not answer. */
function useSlopCop(input: SlopCopInput | null) {
  const query = useRpcQuery({
    contract: slopCopContract,
    pluginId: SLOPCOP_PLUGIN_ID,
    method: "pullRequestReview",
    input: input ?? { repo: "-/-", number: 1 },
    enabled: input !== null,
  });
  return input && !query.error ? (query.data ?? null) : null;
}

function SlopCopStatus({
  input,
  state,
}: {
  input: SlopCopInput;
  state: NonNullable<ReturnType<typeof useSlopCop>>;
}) {
  const again = useRpcMutation({
    contract: slopCopContract,
    pluginId: SLOPCOP_PLUGIN_ID,
    method: "runPullRequestAgain",
  });
  const [message, setMessage] = useState<string | null>(null);
  const now = useNow();
  const onRun = () => {
    setMessage(null);
    again.mutate(input).then(
      (result) => setMessage(result.ok ? null : result.message),
      (error: unknown) =>
        setMessage(error instanceof Error ? error.message : "Couldn't start SlopCop."),
    );
  };
  const run = (
    <button
      type="button"
      className={LINK}
      disabled={!state.canRunAgain || again.isPending}
      title={!state.canRunAgain ? (state.reason ?? undefined) : undefined}
      data-testid="sc-slopcop-run"
      onClick={onRun}
    >
      {again.isPending ? "Starting…" : "Run again"}
    </button>
  );
  const quiet =
    "min-w-0 truncate text-[11px] leading-4 whitespace-pre text-(--tertiary-foreground)";
  let status;
  if (message)
    status = <span className="min-w-0 truncate text-[11px] leading-4 text-warning">{message}</span>;
  else if (state.state === "running")
    status = (
      <>
        <RunGlyph state="running" />
        <span className="min-w-0 truncate text-[11px] leading-4 text-warning">Reviewing…</span>
      </>
    );
  else if (state.state === "failed")
    status = (
      <>
        <RunGlyph state="failed" />
        <span className={quiet}>Failed</span>
      </>
    );
  else if (state.state === "done")
    status = (
      <>
        <RunGlyph state="done" />
        <span className={quiet}>
          {state.finishedAt ? `Done ${shortAge(state.finishedAt, now)} ago` : "Done"}
        </span>
      </>
    );
  else status = <span className={quiet}>Not run</span>;
  return (
    <span className="flex min-w-0 items-center gap-2" data-testid="sc-slopcop-run-state">
      {status}
      {state.state === "running" ? null : run}
      {!state.canRunAgain && state.reason && state.state !== "running" ? (
        <span className="sr-only">{state.reason}</span>
      ) : null}
    </span>
  );
}

// ── Groups and rows ────────────────────────────────────────────────────

function GroupHeader({
  group,
  count,
  children,
}: {
  group: ItemGroup;
  count: number;
  children?: ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2 pt-2 pb-1"
      data-testid="sc-review-group"
      data-group={group.id}
    >
      {group.kind === "person" ? <PersonMark login={group.label} /> : <BotMark />}
      <span className="shrink-0 text-[12px] leading-4 font-semibold whitespace-pre text-muted-foreground">
        {group.label}
      </span>
      <span className="text-[12px] leading-4 text-(--tertiary-foreground)">{count}</span>
      <span className="min-w-0 flex-1" />
      {children}
    </div>
  );
}

const ItemRow = memo(function ItemRow({
  item,
  checked,
  fixing,
  onToggle,
  onOpen,
}: {
  item: ReviewItem;
  checked: boolean;
  /** In an agent batch being fixed: progress instead of the checkbox (board A4). */
  fixing: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onOpen: (item: ReviewItem) => void;
}) {
  const focused = useIsFocused(item.id);
  const title = itemTitle(item);
  const quiet = item.priority !== null && item.priority >= 2;
  return (
    <li
      className={cx("flex min-w-0 gap-2 rounded-[6px] px-2 py-1", focused && "bg-border-hairline")}
      data-testid="sc-review-row"
      data-item={item.id}
    >
      {fixing ? (
        <FixingMark />
      ) : (
        <Checkbox
          checked={checked}
          label={title}
          testId="sc-review-check"
          onChange={(next) => onToggle(item.id, next)}
        />
      )}
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 border-0 bg-transparent p-0 text-start"
      >
        <span
          className={cx(
            "w-full min-w-0 truncate text-[13px] leading-4",
            quiet ? "text-muted-foreground" : "text-foreground",
            focused && "font-semibold",
          )}
        >
          {title}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          {fixing ? (
            <span
              className="shrink-0 text-[12px] leading-4 text-warning"
              data-testid="sc-review-fixing"
            >
              Agent fixing
            </span>
          ) : item.priority !== null ? (
            <PriorityChip priority={item.priority} />
          ) : null}
          <span className="min-w-0 truncate font-mono text-[12px] leading-4 text-(--tertiary-foreground)">
            {placeLabel(item.anchor)}
          </span>
          {item.state !== "open" ? (
            <span className="shrink-0 text-[11px] leading-4 text-(--tertiary-foreground)">
              {item.state === "outdated" ? "Outdated" : "Resolved"}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
});

const BB_GROUP: ItemGroup = { id: "bb", label: "bb review", kind: "bb" };
const SLOPCOP_GROUP: ItemGroup = { id: "slopcop", label: "SlopCop", kind: "slopcop" };

function ItemGroups({
  groups,
  stable,
  runState,
  onToggle,
  onOpen,
}: {
  groups: ReturnType<typeof groupItems>;
  stable: StableReview;
  runState: Record<string, ReactNode>;
  onToggle: (id: string, checked: boolean) => void;
  onOpen: (item: ReviewItem) => void;
}) {
  return groups.map(({ group, items }) => (
    <div key={group.id} className="flex min-w-0 flex-col">
      <GroupHeader group={group} count={items.length}>
        {runState[group.id]}
      </GroupHeader>
      <ul className="m-0 flex list-none flex-col p-0">
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            checked={stable.selected.has(item.id)}
            fixing={stable.fixing.has(item.id)}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </div>
  ));
}

/** "2 being fixed · 2 findings · 2 comments" (board A4): items being fixed count apart. */
function railCounts(fixing: number, rest: readonly ReviewItem[]): string {
  return [fixing > 0 ? `${fixing} being fixed` : null, countLabel(rest) || null]
    .filter(Boolean)
    .join(" · ");
}

function ReviewUnread({ error, refetch }: { error: string | null; refetch: () => void }) {
  if (error)
    return (
      <div className="flex flex-wrap items-center gap-2 px-2">
        <p className="m-0 min-w-0 flex-1 text-[12px] leading-4 text-muted-foreground">
          Couldn't read the review. {error}
        </p>
        <button type="button" className={LINK} onClick={refetch}>
          Try again
        </button>
      </div>
    );
  return (
    <div aria-busy="true" aria-label="Reading the review" className="flex flex-col gap-2 px-2 py-1">
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-3 w-48" />
      <Skeleton className="h-3 w-32" />
    </div>
  );
}

/** Select all, and what a send would carry: "2 findings · 1 reply queued" (board A). */
function SelectionBar({
  all,
  selected,
  queued,
  actions,
}: {
  /** The items that can be checked: none being fixed. */
  all: readonly ReviewItem[];
  selected: ReadonlySet<string>;
  queued: number;
  actions: ReturnType<typeof useReviewActions>;
}) {
  const chosen = all.filter((item) => selected.has(item.id));
  const allChosen = chosen.length === all.length;
  const summary = [
    chosen.length > 0 ? countLabel(chosen) : null,
    queued > 0 ? `${plural(queued, "reply", "replies")} queued` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const onClick = () => {
    const ids = allChosen ? chosen : all.filter((item) => !selected.has(item.id));
    actions.setSelected(
      ids.map((item) => item.id),
      !allChosen,
    );
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 px-2 pt-2">
      <Button
        variant="default"
        data-testid="sc-review-select-all"
        onClick={onClick}
        className="h-6 px-2 font-semibold whitespace-pre"
      >
        {allChosen ? "Clear selection" : "Select all"}
      </Button>
      {summary ? (
        <span
          className="min-w-0 truncate text-[12px] leading-4 text-(--tertiary-foreground)"
          data-testid="sc-review-selection"
        >
          {summary}
        </span>
      ) : null}
    </div>
  );
}

export const ReviewSection = memo(function ReviewSection({
  changeKey,
  repo,
  number,
}: {
  changeKey: ChangeKey;
  /** "owner/name" and the pull request's number, for SlopCop's run; number null without one. */
  repo: string;
  number: number | null;
}) {
  const { review, stable, error, refetch } = useChangeReview(changeKey);
  const actions = useReviewActions(changeKey);
  const focus = useContext(FocusContext);
  const groups = useMemo(() => groupItems(stable.items), [stable.items]);
  const slopCopIn = useMemo(() => slopCopInput(repo, number), [repo, number]);
  const slopCop = useSlopCop(slopCopIn);
  const onToggle = useCallback(
    (id: string, checked: boolean) => actions.setSelected([id], checked),
    [actions],
  );
  const onOpen = useCallback((item: ReviewItem) => focus?.reveal(item), [focus]);
  const run = review?.runs[0] ?? null;
  // Items being fixed have no checkbox: they count apart, and Select all leaves them.
  const all = stable.items.filter((item) => !stable.fixing.has(item.id));
  const counts = railCounts(stable.items.length - all.length, all);
  const batch = latestBatch(stable.batches);
  const slopCopStatus =
    slopCopIn && slopCop ? <SlopCopStatus input={slopCopIn} state={slopCop} /> : null;
  // Each run's state beside its group's header.
  const runState: Record<string, ReactNode> = {
    bb: <RunStatus changeKey={changeKey} run={run} />,
    slopcop: slopCopStatus,
  };
  const hasGroup = (id: string) => groups.some((entry) => entry.group.id === id);
  const lateSlopCop = !hasGroup("slopcop") && slopCop !== null && slopCop.state !== "none";

  const body = !review ? (
    <ReviewUnread error={error} refetch={refetch} />
  ) : (
    <>
      {hasGroup("bb") ? null : (
        <GroupHeader group={BB_GROUP} count={0}>
          {runState.bb}
        </GroupHeader>
      )}
      <ItemGroups
        groups={groups}
        stable={stable}
        runState={runState}
        onToggle={onToggle}
        onOpen={onOpen}
      />
      {lateSlopCop ? (
        <GroupHeader group={SLOPCOP_GROUP} count={0}>
          {slopCopStatus}
        </GroupHeader>
      ) : null}
      {review.forge.problem ? (
        <p className={cx(NOTE, "pt-1")}>
          {describeProblem(review.forge.problem)} These are the last GitHub comments bb read.
        </p>
      ) : null}
      {all.length > 0 ? (
        <SelectionBar
          all={all}
          selected={stable.selected}
          queued={sendableDrafts(stable.drafts).length}
          actions={actions}
        />
      ) : null}
    </>
  );
  return (
    <section className="flex min-w-0 flex-col" aria-label="Review" data-testid="sc-rail-review">
      {batch ? (
        <div className="pb-3">
          <BatchBanner changeKey={changeKey} batch={batch} />
        </div>
      ) : null}
      <div className="flex items-baseline justify-between gap-2 pb-2">
        <h2 className={RAIL_LABEL}>Review</h2>
        {counts ? (
          <span className="text-[12px] leading-4 text-(--tertiary-foreground)">{counts}</span>
        ) : null}
      </div>
      {body}
    </section>
  );
});
