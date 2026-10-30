import type { ReviewDiffLayout } from "../../shared/review-protocol/index.ts";
import {
  type ReactElement,
  useCallback,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useReviewSession } from "./host/review-session.tsx";
import { SlidersIcon, SplitLayoutIcon, UnifiedLayoutIcon } from "./icons.tsx";
import { useDismissOnOutside } from "./use-dismiss-on-outside.ts";
import { useTooltip } from "./use-tooltip.ts";
import { useTopbarPopover } from "./use-topbar-popover.ts";

const LAYOUT_OPTIONS: ReadonlyArray<{
  layout: ReviewDiffLayout;
  label: string;
  Icon: () => ReactElement;
}> = [
  { layout: "unified", label: "Unified", Icon: UnifiedLayoutIcon },
  { layout: "split", label: "Split", Icon: SplitLayoutIcon },
];

/**
 * The toolbar's diff settings popover. Today it holds one control, the
 * unified/split layout; the popover shape leaves room for the diff options
 * that follow it without spending more toolbar width.
 */
export function DiffLayoutControl(): ReactElement {
  const tooltip = useTooltip("Diff settings");
  const session = useReviewSession();
  const bridge = session.bridge;

  const layout = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => {
        const subscription = bridge.onDidChangeDiffLayout(onChange);

        return () => subscription.dispose();
      },
      [bridge],
    ),
    () => bridge.currentDiffLayout(),
  );

  const controlRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const popoverRef = useTopbarPopover(open, controlRef);
  // The desktop confirms a write by round-tripping the setting through its
  // change event. The choice shows at once and holds until that confirmation,
  // or drops back if the write fails.
  const [pending, setPending] = useState<ReviewDiffLayout | null>(null);

  if (pending !== null && layout === pending) setPending(null);

  const shownLayout = pending ?? layout;
  const layoutLabelId = useId();

  useDismissOnOutside(controlRef, open, setOpen, true, true);

  const chooseLayout = (next: ReviewDiffLayout) => {
    if (next === shownLayout) return;
    setPending(next);
    bridge.setDiffLayout(next).catch(() => {
      setPending(null);
    });
  };

  return (
    <div ref={controlRef} className="review-diff-settings">
      <button
        type="button"
        className="review-diff-settings-button"
        aria-label="Diff settings"
        ref={tooltip}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <SlidersIcon />
      </button>
      {open ? (
        <div
          ref={popoverRef}
          popover="manual"
          className="review-diff-settings-popover"
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a manual popover; <dialog> adds modal semantics and its own UA box styles
          role="dialog"
          aria-label="Diff settings"
        >
          <div className="review-diff-settings-title">Diff settings</div>
          <div className="review-diff-settings-field">
            <span id={layoutLabelId} className="review-diff-settings-label">
              Layout
            </span>
            <div
              className="review-segmented review-diff-settings-segmented"
              role="radiogroup"
              aria-labelledby={layoutLabelId}
            >
              {LAYOUT_OPTIONS.map(({ layout: option, label, Icon }) => (
                <button
                  key={option}
                  type="button"
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a segmented control drawn with buttons; native radios cannot take this styling
                  role="radio"
                  aria-checked={option === shownLayout}
                  className={
                    option === shownLayout
                      ? "review-segment review-segment--active"
                      : "review-segment"
                  }
                  onClick={() => chooseLayout(option)}
                >
                  <Icon />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
