/**
 * The Change's findings as the thread tab's card and the chat's card list
 * them (board B): one line each, in the rail's order, with the checkboxes
 * the review page's rail and annotations share, since all read the one keyed
 * `reviewForChange` entry. Five lines, then "Show all N". "Fix N selected"
 * sends the checked ones to the card's own thread.
 */
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { memo, useCallback, useMemo, useState } from "react";
import type { ChangeKey } from "../core/ids.ts";
import type { ReviewItem } from "../core/items.ts";
import { reviewPath } from "../core/review.ts";
import { cx } from "./format.ts";
import { PANEL_PATH } from "./page/hooks.ts";
import { useChangeReview, useReviewActions, type ReviewActions } from "./review-data.ts";
import {
  countLabel,
  itemTitle,
  latestBatch,
  placeLabel,
  railOrder,
  type StableReview,
} from "./review-model.ts";
import { Checkbox, FixingMark, PriorityChip } from "./review-ui.tsx";
import { BatchLine, useFixSelected, type FixSelected } from "./send.tsx";
import { Button } from "./components/ui/button.tsx";

/** How many lines a card shows before "Show all N". Board B shows four and says no more. */
export const CARD_ROWS = 5;

const FindingRow = memo(function FindingRow({
  item,
  checked,
  fixing,
  onToggle,
  onOpen,
}: {
  item: ReviewItem;
  checked: boolean;
  fixing: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onOpen: (item: ReviewItem) => void;
}) {
  const title = itemTitle(item);
  return (
    <li
      className="flex h-6 min-w-0 items-center gap-2"
      data-testid="sc-finding"
      data-item={item.id}
    >
      {fixing ? (
        <span title="Agent fixing" className="flex">
          <FixingMark />
        </span>
      ) : (
        <Checkbox
          checked={checked}
          label={title}
          testId="sc-finding-check"
          onChange={(next) => onToggle(item.id, next)}
        />
      )}
      {item.priority !== null ? <PriorityChip priority={item.priority} /> : null}
      <button
        type="button"
        onClick={() => onOpen(item)}
        title={title}
        className={cx(
          "min-w-0 flex-1 cursor-pointer truncate border-0 bg-transparent p-0 text-start text-[12px] leading-4 hover:underline",
          item.priority !== null && item.priority >= 2
            ? "text-muted-foreground"
            : "text-foreground",
        )}
      >
        {title}
      </button>
      <span className="shrink-0 font-mono text-[11px] leading-4 text-(--tertiary-foreground)">
        {placeLabel(item.anchor)}
      </span>
    </li>
  );
});

/** The items in the rail's order: the first five, or all of them once asked. */
export function FindingList({
  changeKey,
  stable,
  actions,
  className,
}: {
  changeKey: ChangeKey;
  stable: StableReview;
  actions: ReviewActions;
  className?: string;
}) {
  const navigate = useBbNavigate();
  const [all, setAll] = useState(false);
  const items = useMemo(() => railOrder(stable.items), [stable.items]);
  const onToggle = useCallback(
    (id: string, checked: boolean) => actions.setSelected([id], checked),
    [actions],
  );
  const onOpen = useCallback(
    (item: ReviewItem) =>
      navigate.toPluginPanel(PANEL_PATH, {
        subPath: reviewPath({
          key: changeKey,
          tab: "files",
          path: item.anchor.path,
          line: item.anchor.line,
        }),
      }),
    [navigate, changeKey],
  );
  const shown = all ? items : items.slice(0, CARD_ROWS);
  return (
    <div className={cx("flex min-w-0 flex-col", className)}>
      <ul className="m-0 flex list-none flex-col p-0">
        {shown.map((item) => (
          <FindingRow
            key={item.id}
            item={item}
            checked={stable.selected.has(item.id)}
            fixing={stable.fixing.has(item.id)}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))}
      </ul>
      {items.length > CARD_ROWS ? (
        <button
          type="button"
          data-testid="sc-findings-more"
          onClick={() => setAll((value) => !value)}
          className="flex h-6 shrink-0 cursor-pointer items-center self-start border-0 bg-transparent p-0 text-[12px] leading-4 text-muted-foreground hover:text-foreground"
        >
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      ) : null}
    </div>
  );
}

export function OpenReviewArrow() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0">
      <path
        d="M3.5 8.5L8.5 3.5M4.5 3.5H8.5V7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "Fix 2 selected"; drawn by each card in its own style. */
export function fixLabel(fix: FixSelected): string {
  if (fix.pending) return "Sending…";
  return fix.count > 0 ? `Fix ${fix.count} selected` : "Fix selected";
}

export const FindingsCard = memo(function FindingsCard({
  changeKey,
  threadId,
  head,
  visible,
}: {
  changeKey: ChangeKey;
  /** This tab's thread: "Fix N selected" sends here. */
  threadId: string;
  head: string | null;
  visible: boolean;
}) {
  const { stable } = useChangeReview(changeKey, visible);
  const actions = useReviewActions(changeKey);
  const navigate = useBbNavigate();
  const fix = useFixSelected(changeKey, stable, head, threadId);
  const items = stable.items;
  if (items.length === 0) return null;
  const open = items.filter((item) => !stable.fixing.has(item.id));
  const unchecked = open.filter((item) => !stable.selected.has(item.id));
  const batch = latestBatch(stable.batches);
  return (
    <section
      aria-label="Findings"
      data-testid="sc-findings-card"
      className="flex min-w-0 flex-col overflow-clip rounded-[8px] border border-solid border-border"
    >
      <div className="flex min-w-0 items-center gap-2 px-3 pt-2 pb-1">
        <h2 className="m-0 min-w-0 flex-1 truncate text-[11px] leading-4 font-normal tracking-[0.06em] text-(--tertiary-foreground) uppercase">
          {countLabel(items)}
        </h2>
        {open.length > 0 ? (
          <button
            type="button"
            data-testid="sc-findings-select-all"
            onClick={() =>
              unchecked.length > 0
                ? actions.setSelected(
                    unchecked.map((item) => item.id),
                    true,
                  )
                : actions.setSelected(
                    open.map((item) => item.id),
                    false,
                  )
            }
            className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[12px] leading-4 text-muted-foreground hover:text-foreground"
          >
            {unchecked.length > 0 ? "Select all" : "Clear selection"}
          </button>
        ) : null}
      </div>
      <FindingList
        changeKey={changeKey}
        stable={stable}
        actions={actions}
        className="px-3 pt-0 pb-1"
      />
      {batch && batch.destination === "agent" ? (
        <div className="flex min-w-0 px-3 pb-2">
          <BatchLine
            changeKey={changeKey}
            batch={batch}
            here={batch.target.kind === "thread" && batch.target.threadId === threadId}
          />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-solid border-border-hairline bg-surface-recessed px-3 py-2">
        <Button
          variant="outline"
          data-testid="sc-fix-selected"
          disabled={fix.count === 0 || fix.pending || head === null}
          onClick={fix.fix}
          className="px-3 font-semibold"
        >
          {fixLabel(fix)}
        </Button>
        {fix.error ? (
          <span role="alert" className="min-w-0 truncate text-[12px] leading-4 text-warning">
            {fix.error}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        <Button
          variant="outline"
          onClick={() =>
            navigate.toPluginPanel(PANEL_PATH, { subPath: reviewPath({ key: changeKey }) })
          }
          className="gap-1 px-3 font-normal"
        >
          Open review
          <OpenReviewArrow />
        </Button>
      </div>
    </section>
  );
});
