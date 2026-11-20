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
} from "react";
import type { ChangeKey } from "../../core/ids.ts";
import { Button } from "../components/ui/button.tsx";
import { plural } from "../format.ts";
import { useChangeReview } from "../review-data.ts";
import { Chevron } from "./icons.tsx";
import { FocusContext } from "./review-focus.ts";

/** The bar's height plus its gap from the bottom, set on the bar's host while the bar shows. */
const SPACE = "--sc-review-bar-space";

/**
 * Pads a scroller's content by the room the bar takes, so its last lines can
 * scroll above the bar. Unset (no bar), the padding is 0.
 */
export const CLEAR_REVIEW_BAR = "pb-(--sc-review-bar-space)";

function Step({
  direction,
  onClick,
  label,
}: {
  direction: -1 | 1;
  onClick: () => void;
  label: string;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      onClick={onClick}
      // 32px drawn; a finger gets 44px, out to the pill's edge.
      className="relative size-8 px-0 max-md:pointer-coarse:after:absolute max-md:pointer-coarse:after:-inset-1.5"
    >
      <Chevron className={direction < 0 ? "rotate-90" : "-rotate-90"} />
    </Button>
  );
}

/**
 * Steps through the open review items in reading order, revealing each in the
 * diff, beside `children`, the send controls.
 *
 * Render it as a child of a `relative` element that also holds the review's
 * scrollers: it floats over that element's bottom edge and sets
 * `--sc-review-bar-space` on it, which `CLEAR_REVIEW_BAR` reads.
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
  const go = (step: -1 | 1) => {
    if (items.length === 0) return;
    const next =
      at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
    focus?.reveal(items[next]!);
  };

  const float = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = float.current;
    const host = element?.parentElement;
    // An engine without ResizeObserver (tests) reserves no room.
    if (!element || !host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.borderBoxSize[0]?.blockSize;
      if (height !== undefined) host.style.setProperty(SPACE, `${Math.ceil(height)}px`);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      host.style.removeProperty(SPACE);
    };
  }, []);

  return (
    <div
      ref={float}
      // Clicks pass through the gap around the pill to the diff. bb's shell already lifts the page
      // above the home indicator; where it gives no inset (Android, an open keyboard) the pill keeps
      // 1.5rem clear of the screen's rounded corners. Where the page itself runs under the home
      // indicator (--plugin-page-bottom-inset), the pill rises by that too.
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-3 pt-2 pb-[calc(max(0.75rem,calc(1.5rem-var(--bb-content-bottom-inset,0px)))+var(--plugin-page-bottom-inset,0px))]"
    >
      <div
        data-testid="sc-review-bar"
        // Sized to its controls; a narrow panel wraps the send controls under the pager.
        className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1.5 rounded-xl max-md:pointer-coarse:gap-y-3 border border-solid border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
      >
        {items.length > 0 ? (
          <div className="flex shrink-0 items-center">
            <Step direction={-1} label="Previous item" onClick={() => go(-1)} />
            <span
              className="px-1 text-[13px] leading-5 whitespace-pre text-foreground tabular-nums"
              data-testid="sc-review-bar-position"
            >
              {at < 0 ? plural(items.length, "item") : `${at + 1} of ${items.length}`}
            </span>
            <Step direction={1} label="Next item" onClick={() => go(1)} />
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
