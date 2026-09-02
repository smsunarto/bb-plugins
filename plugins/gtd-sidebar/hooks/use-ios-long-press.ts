import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type TouchEvent,
} from "react";
import { useLongPress } from "@uidotdev/usehooks";

/**
 * `UILongPressGestureRecognizer.minimumPressDuration` default: 0.5 s.
 * https://developer.apple.com/documentation/uikit/uilongpressgesturerecognizer/minimumpressduration
 */
export const IOS_LONG_PRESS_MS = 500;

/**
 * `UILongPressGestureRecognizer.allowableMovement` default: 10 points. A CSS
 * pixel is a point on iOS, so the tolerance carries over unchanged.
 * https://developer.apple.com/documentation/uikit/uilongpressgesturerecognizer/allowablemovement
 */
export const IOS_LONG_PRESS_ALLOWABLE_MOVEMENT_PX = 10;

/**
 * A touch long press with UIKit's defaults: fires after 500 ms unless the
 * finger drifts more than 10 px or a second finger lands. `useLongPress`
 * supplies the timer; movement tracking is added here because the hook only
 * cancels on touch end.
 *
 * Touch and mobile-compact mouse clicks are tracked.
 *
 * Exposes `isPressing` to provide immediate touch-down visual feedback before
 * the menu appears.
 *
 * After a fire, the tap's trailing `click` on the row itself is swallowed so
 * the row's anchor does not also navigate. Only the row's own DOM subtree
 * counts: React portals bubble through the React tree, so a menu rendered
 * by the row must not be caught, or its first tap would be cancelled (and
 * with it the `<input switch>` toggle that plays the iOS haptic).
 */
export function useIosLongPress(
  onLongPress: () => void,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const [isPressing, setIsPressing] = useState(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clearFired = useRef<ReturnType<typeof setTimeout> | null>(null);

  const callback = useCallback(() => {
    fired.current = true;
    setIsPressing(false);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate(10);
      } catch {}
    }
    onLongPress();
  }, [onLongPress]);

  const onCancel = useCallback(() => {
    origin.current = null;
    setIsPressing(false);
  }, []);

  const press = useLongPress(callback, { threshold: IOS_LONG_PRESS_MS, onCancel });

  const handlers = useMemo(() => {
    if (!enabled) return {};

    const onTouchStart = (event: TouchEvent<HTMLElement>) => {
      fired.current = false;
      if (event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      origin.current = { x: touch.clientX, y: touch.clientY };
      setIsPressing(true);
      press.onTouchStart(event);
    };

    const onTouchMove = (event: TouchEvent<HTMLElement>) => {
      const start = origin.current;
      if (start === null) return;
      const touch = event.touches[0];
      const moved =
        event.touches.length !== 1 ||
        touch === undefined ||
        Math.hypot(touch.clientX - start.x, touch.clientY - start.y) >
          IOS_LONG_PRESS_ALLOWABLE_MOVEMENT_PX;
      // `onTouchEnd` is the hook's cancel path: it clears the timer and resets.
      if (moved) {
        setIsPressing(false);
        press.onTouchEnd(event);
      }
    };

    const onTouchEnd = (event: TouchEvent<HTMLElement>) => {
      setIsPressing(false);
      press.onTouchEnd(event);
      // Safari's synthetic click follows touchend at once when it comes at
      // all; a later click is a new tap and must go through.
      if (clearFired.current) clearTimeout(clearFired.current);
      clearFired.current = setTimeout(() => {
        fired.current = false;
      }, 300);
    };

    const onMouseDown = (event: MouseEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      fired.current = false;
      origin.current = { x: event.clientX, y: event.clientY };
      setIsPressing(true);
      press.onMouseDown(event);
    };

    const onMouseMove = (event: MouseEvent<HTMLElement>) => {
      const start = origin.current;
      if (start === null) return;
      const moved =
        Math.hypot(event.clientX - start.x, event.clientY - start.y) >
        IOS_LONG_PRESS_ALLOWABLE_MOVEMENT_PX;
      if (moved) {
        setIsPressing(false);
        press.onMouseUp(event);
      }
    };

    const onMouseUp = (event: MouseEvent<HTMLElement>) => {
      setIsPressing(false);
      press.onMouseUp(event);
      if (clearFired.current) clearTimeout(clearFired.current);
      clearFired.current = setTimeout(() => {
        fired.current = false;
      }, 300);
    };

    const onMouseLeave = (event: MouseEvent<HTMLElement>) => {
      setIsPressing(false);
      press.onMouseLeave(event);
    };

    return {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel: onTouchEnd,
      onMouseDown,
      onMouseMove,
      onMouseUp,
      onMouseLeave,
      onClickCapture: (event: MouseEvent<HTMLElement>) => {
        if (!fired.current) return;
        if (!event.currentTarget.contains(event.target as Node)) return;
        fired.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
      // Android fires a native contextmenu at its own long-press timing;
      // iOS shows the link callout instead, which `WebkitTouchCallout` mutes.
      onContextMenu: (event: MouseEvent<HTMLElement>) => event.preventDefault(),
      style: {
        WebkitTouchCallout: "none",
        WebkitUserSelect: "none",
        userSelect: "none",
      } satisfies CSSProperties,
    };
  }, [enabled, press]);

  return { isPressing, handlers };
}
