/**
 * The thread tab's findings card (board B): the Change's findings and
 * comments, one line each, with the checkboxes the review page's rail and
 * annotations share, since all read the one keyed `reviewForChange` entry.
 * Drawn only once the Change has items. Sending them is not here yet.
 */
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { memo, useCallback, useMemo } from "react";
import type { ChangeKey } from "../core/ids.ts";
import { groupItems, type ReviewItem } from "../core/items.ts";
import { reviewPath } from "../core/review.ts";
import { cx } from "./format.ts";
import { PANEL_PATH } from "./page/hooks.ts";
import { useChangeReview, useReviewActions } from "./review-data.ts";
import { countLabel, itemTitle, placeLabel } from "./review-model.ts";
import { Checkbox, PriorityChip } from "./review-ui.tsx";

const FindingRow = memo(function FindingRow({
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
  const title = itemTitle(item);
  return (
    <li
      className="flex h-6 min-w-0 items-center gap-2"
      data-testid="sc-finding"
      data-item={item.id}
    >
      <Checkbox
        checked={checked}
        label={title}
        testId="sc-finding-check"
        onChange={(next) => onToggle(item.id, next)}
      />
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

export const FindingsCard = memo(function FindingsCard({
  changeKey,
  visible,
}: {
  changeKey: ChangeKey;
  visible: boolean;
}) {
  const { stable } = useChangeReview(changeKey, visible);
  const actions = useReviewActions(changeKey);
  const navigate = useBbNavigate();
  const items = useMemo(
    () => groupItems(stable.items).flatMap((group) => group.items),
    [stable.items],
  );
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
  if (items.length === 0) return null;
  const unchecked = items.filter((item) => !stable.selected.has(item.id));
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
                  items.map((item) => item.id),
                  false,
                )
          }
          className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[12px] leading-4 text-muted-foreground hover:text-foreground"
        >
          {unchecked.length > 0 ? "Select all" : "Clear selection"}
        </button>
      </div>
      <ul className="m-0 flex list-none flex-col px-3 pt-0 pb-1">
        {items.map((item) => (
          <FindingRow
            key={item.id}
            item={item}
            checked={stable.selected.has(item.id)}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))}
      </ul>
      <div className="flex min-w-0 items-center gap-2 border-t border-solid border-border-hairline bg-surface-recessed px-3 py-2">
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          onClick={() =>
            navigate.toPluginPanel(PANEL_PATH, { subPath: reviewPath({ key: changeKey }) })
          }
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-[6px] border border-solid border-border bg-transparent px-3 text-[12px] leading-4 text-foreground hover:bg-surface-raised"
        >
          Open review
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
        </button>
      </div>
    </section>
  );
});
