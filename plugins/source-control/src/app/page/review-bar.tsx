/**
 * The narrow review's floating bar (board E): "‹ 1 of 4 ›" steps through the
 * open review items, beside the page's send controls. It floats centered over
 * the bottom of the review, and the scrollers under it keep room for it.
 */
import {
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import type { ChangeKey } from "../../core/ids.ts";
import { Button } from "../components/ui/button.tsx";
import { surface } from "../components/ui/surface.ts";
import { cx, plural } from "../format.ts";
import { useChangeReview } from "../review-data.ts";
import { Chevron } from "./icons.tsx";
import { FocusContext, type PagerDirection } from "./review-focus.ts";

/** The bar's height plus its gap from the bottom, set on the bar's host while the bar shows. */
const SPACE = "--sc-review-bar-space";

/**
 * The classes that keep a scroller's content clear of the bar; with no bar
 * they add nothing. `scroll` goes on the scroller, so focus and scroll-into-view
 * stop above the pill. `content` pads a scroller's content that has no bottom
 * padding of its own; `contentPb4` replaces `pb-4`, keeping its 16px under
 * the room the bar takes.
 */
const CLEAR_REVIEW_BAR = {
  scroll: "scroll-pb-[var(--sc-review-bar-space,0px)]",
  content: "pb-[var(--sc-review-bar-space,0px)]",
  contentPb4: "pb-[calc(1rem+var(--sc-review-bar-space,0px))]",
} as const;

/** Keep the bar in the scroll chain and the content wrapper first for diff virtualization. */
export function ReviewScroller({
  bar,
  children,
  className,
  contentClassName,
  scroller,
  testId,
}: {
  bar?: ReactNode;
  children: ReactNode;
  className: string;
  contentClassName?: string;
  scroller?: RefObject<HTMLDivElement | null>;
  testId?: string;
}) {
  return (
    <div ref={scroller} data-testid={testId} className={cx(className, CLEAR_REVIEW_BAR.scroll)}>
      <div
        className={cx(
          contentClassName,
          contentClassName ? CLEAR_REVIEW_BAR.contentPb4 : CLEAR_REVIEW_BAR.content,
          !!bar && "min-h-full",
        )}
      >
        {children}
      </div>
      {bar}
    </div>
  );
}

/**
 * Sets `--sc-review-bar-space` on the bar's host to the height of `float`,
 * the bar with its gap from the bottom, for as long as the bar is mounted.
 * The border box is observed, so a change of the bottom inset (the gap) moves
 * the reserve with the pill.
 */
export function useReserveSpace(float: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = float.current;
    const host = element?.parentElement;
    // An engine without ResizeObserver reserves no room; the bar still floats.
    if (!element || !host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.borderBoxSize[0]?.blockSize;
      if (height !== undefined) host.style.setProperty(SPACE, `${Math.ceil(height)}px`);
    });
    observer.observe(element, { box: "border-box" });
    return () => {
      observer.disconnect();
      host.style.removeProperty(SPACE);
    };
  }, [float]);
}

function Step({
  direction,
  onClick,
  label,
  buttonRef,
}: {
  direction: PagerDirection;
  onClick: (direction: PagerDirection, button: HTMLButtonElement) => void;
  label: string;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Button
      ref={buttonRef}
      size="sm"
      variant="ghost"
      aria-label={label}
      onClick={(event) => onClick(direction, event.currentTarget)}
      // 32px drawn; a finger gets 44px, out to the pill's edge. Any coarse pointer, not only a
      // phone's: the bar shows by its container's width, so a tablet's narrow panel has it too.
      className="relative size-8 px-0 pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5"
    >
      <Chevron className={direction < 0 ? "rotate-90" : "-rotate-90"} />
    </Button>
  );
}

/**
 * Steps through the open review items in reading order, revealing each in the
 * diff, beside `children`, the send controls.
 *
 * Render it after the content in ReviewScroller. Its negative margin overlaps
 * the reserved clearance so the bar does not add a second gap.
 */
export function ReviewBar({
  changeKey,
  order,
  children,
}: {
  changeKey: ChangeKey;
  /** Each path's place in the reading order. */
  order: ReadonlyMap<string, number>;
  /** The send controls. */
  children: ReactNode;
}) {
  const { stable } = useChangeReview(changeKey);
  const focus = useContext(FocusContext);
  const items = useMemo(
    () =>
      stable.items
        .filter((item) => item.state === "open" && !stable.fixing.has(item.id))
        .toSorted(
          (a, b) =>
            (order.get(a.anchor.path) ?? Infinity) - (order.get(b.anchor.path) ?? Infinity) ||
            (a.anchor.line ?? 0) - (b.anchor.line ?? 0),
        ),
    [stable.items, stable.fixing, order],
  );
  const subscribe = useCallback(
    (listener: () => void) => focus?.subscribe(listener) ?? (() => {}),
    [focus],
  );
  const focused = useSyncExternalStore(subscribe, () => focus?.getFocused() ?? null);
  const at = items.findIndex((item) => item.id === focused);
  const go = (step: PagerDirection, button: HTMLButtonElement) => {
    if (items.length === 0) return;
    const next =
      at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
    focus?.reveal(items[next]!, button.ownerDocument.activeElement === button ? step : null);
  };

  const previousButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const hasPager = items.length > 0;
  useLayoutEffect(() => {
    if (!hasPager) return;
    const direction = focus?.takePagerFocus();
    if (!direction) return;
    const button = (direction < 0 ? previousButton : nextButton).current;
    // Restore the pager's focus if removing the old bar dropped it to the page.
    if (button && button.ownerDocument.activeElement === button.ownerDocument.body) {
      button.focus({ preventScroll: true });
    }
  }, [focus, hasPager]);

  const float = useRef<HTMLDivElement>(null);
  useReserveSpace(float);

  return (
    <div
      ref={float}
      // Clicks pass through the gap around the pill to the diff. bb's shell already lifts the page
      // above the home indicator; where it gives no inset (Android, an open keyboard) the pill keeps
      // 1.5rem clear of the screen's rounded corners. Where the page itself runs under the home
      // indicator (--plugin-page-bottom-inset), the pill rises by that too.
      className="@container pointer-events-none sticky bottom-0 left-0 z-10 mt-[calc(0px-var(--sc-review-bar-space,0px))] flex justify-center px-3 pt-2 pb-[calc(max(0.75rem,calc(1.5rem-var(--bb-content-bottom-inset,0px)))+var(--plugin-page-bottom-inset,0px))]"
    >
      <div
        data-testid="sc-review-bar"
        // Below the usual row width (389px), stack the groups to keep the pill compact.
        // At wider sizes, longer send controls can still wrap to their own row.
        // The 12px coarse-pointer row gap keeps the extended hit areas from overlapping.
        className={cx(
          surface.edge,
          "pointer-events-auto flex w-fit max-w-full flex-col items-center gap-x-2 gap-y-1.5 rounded-xl bg-popover p-1.5 text-popover-foreground shadow-lg pointer-coarse:gap-y-3 @[389px]:flex-row @[389px]:flex-wrap @[389px]:justify-center",
        )}
      >
        {hasPager ? (
          <div className="flex shrink-0 items-center">
            <Step direction={-1} label="Previous item" onClick={go} buttonRef={previousButton} />
            <span
              className="px-1 text-[13px] leading-5 whitespace-pre text-foreground tabular-nums"
              data-testid="sc-review-bar-position"
            >
              {at < 0 ? plural(items.length, "item") : `${at + 1} of ${items.length}`}
            </span>
            <Step direction={1} label="Next item" onClick={go} buttonRef={nextButton} />
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
