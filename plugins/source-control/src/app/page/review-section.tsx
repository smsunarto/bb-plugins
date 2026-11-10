/**
 * The rail's Review section (board A): every finding and comment on the
 * Change, grouped by author, each with the checkbox the diff's annotation
 * and the thread tab's card share. bb's group carries its review run's
 * state and the action that starts one.
 */
import {
  experimental_useRpcMutation as useRpcMutation,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { memo, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { describeProblem } from "../../core/change.ts";
import type { ChangeKey } from "../../core/ids.ts";
import { groupItems, type ItemGroup, type ReviewItem, type ReviewRun } from "../../core/items.ts";
import { sourceControlContract } from "../../contract/rpc.ts";
import { cx, plural } from "../format.ts";
import { useChangeReview, useReviewActions } from "../review-data.ts";
import { countLabel, itemTitle, placeLabel } from "../review-model.ts";
import { BotMark, Checkbox, PersonMark, PriorityChip, RunGlyph } from "../review-ui.tsx";
import { Bar } from "../ui.tsx";
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
  onToggle,
  onOpen,
}: {
  item: ReviewItem;
  checked: boolean;
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
      <Checkbox
        checked={checked}
        label={title}
        testId="sc-review-check"
        onChange={(next) => onToggle(item.id, next)}
      />
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
          {item.priority !== null ? <PriorityChip priority={item.priority} /> : null}
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

export const ReviewSection = memo(function ReviewSection({ changeKey }: { changeKey: ChangeKey }) {
  const { review, stable, error, refetch } = useChangeReview(changeKey);
  const actions = useReviewActions(changeKey);
  const focus = useContext(FocusContext);
  const groups = useMemo(() => groupItems(stable.items), [stable.items]);
  const onToggle = useCallback(
    (id: string, checked: boolean) => actions.setSelected([id], checked),
    [actions],
  );
  const onOpen = useCallback((item: ReviewItem) => focus?.reveal(item), [focus]);
  const run = review?.runs[0] ?? null;
  const all = stable.items;
  const chosen = all.filter((item) => stable.selected.has(item.id));
  const allChosen = all.length > 0 && chosen.length === all.length;
  const counts = countLabel(all);

  let body;
  if (!review) {
    body = error ? (
      <div className="flex flex-wrap items-center gap-2 px-2">
        <p className="m-0 min-w-0 flex-1 text-[12px] leading-4 text-muted-foreground">
          Couldn't read the review. {error}
        </p>
        <button type="button" className={LINK} onClick={refetch}>
          Try again
        </button>
      </div>
    ) : (
      <div
        aria-busy="true"
        aria-label="Reading the review"
        className="flex flex-col gap-2 px-2 py-1"
      >
        <Bar className="h-3 w-40" />
        <Bar className="h-3 w-48" />
        <Bar className="h-3 w-32" />
      </div>
    );
  } else {
    const hasBb = groups.some((entry) => entry.group.id === "bb");
    body = (
      <>
        {hasBb ? null : (
          <GroupHeader group={BB_GROUP} count={0}>
            <RunStatus changeKey={changeKey} run={run} />
          </GroupHeader>
        )}
        {groups.map(({ group, items }) => (
          <div key={group.id} className="flex min-w-0 flex-col">
            <GroupHeader group={group} count={items.length}>
              {group.id === "bb" ? <RunStatus changeKey={changeKey} run={run} /> : null}
            </GroupHeader>
            <ul className="m-0 flex list-none flex-col p-0">
              {items.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  checked={stable.selected.has(item.id)}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          </div>
        ))}
        {review.forge.problem ? (
          <p className={cx(NOTE, "pt-1")}>
            {describeProblem(review.forge.problem)} These are the last GitHub comments bb read.
          </p>
        ) : null}
        {all.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2 px-2 pt-2">
            <button
              type="button"
              data-testid="sc-review-select-all"
              onClick={() =>
                actions.setSelected(
                  (allChosen ? chosen : all.filter((item) => !stable.selected.has(item.id))).map(
                    (item) => item.id,
                  ),
                  !allChosen,
                )
              }
              className="flex h-6 shrink-0 cursor-pointer items-center rounded-[6px] border-0 bg-foreground px-2 text-[12px] leading-4 font-semibold whitespace-pre text-background hover:opacity-90"
            >
              {allChosen ? "Clear selection" : "Select all"}
            </button>
            {chosen.length > 0 ? (
              <span className="min-w-0 truncate text-[12px] leading-4 text-(--tertiary-foreground)">
                {countLabel(chosen)} selected
              </span>
            ) : null}
          </div>
        ) : null}
      </>
    );
  }
  return (
    <section className="flex min-w-0 flex-col" aria-label="Review" data-testid="sc-rail-review">
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
