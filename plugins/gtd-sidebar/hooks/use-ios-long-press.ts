import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type MouseEvent,
  type TouchEvent,
} from "react";
import { nativeHaptic } from "../lib/native-haptics";

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
 * How long a touch rests before the row tints, so a scroll flick never flashes
 * the row it starts on. Android's `ViewConfiguration` tap timeout: the wait to
 * see whether a touch is a tap or a scroll.
 * https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/view/ViewConfiguration.java
 */
export const TOUCH_PRESS_FEEDBACK_MS = 100;

/** A hold that landed: the element it started on and where the finger is. */
export interface LongPress<Target> {
  target: Target;
  x: number;
  y: number;
}

interface LongPressOptions<Target> {
  enabled?: boolean;
  /**
   * The thing a press on `element` holds, or null to leave the press alone.
   * One recognizer on a list's container serves every row this way, so a row
   * mounts no handlers or timers of its own.
   */
  resolve: (element: Element) => Target | null;
  /** Whether a held primary mouse button counts, as on a narrow desktop window. */
  mouse?: boolean;
  /** The target under a resting finger, for press feedback; null once it lifts. */
  onPressChange?: (target: Target | null) => void;
}

/**
 * A long press with UIKit's defaults: fires after 500 ms unless the pointer
 * drifts more than 10 px, a second finger lands, or the press ends.
 *
 * `onPressChange` reports the target after 100 ms of touch (the native tap
 * timeout, so scroll flicks don't flash) and at once for a mouse.
 *
 * After a fire, the tap's trailing `click` inside the element is swallowed so
 * the row's anchor does not also navigate. Only the element's own DOM subtree
 * counts: React portals bubble through the React tree, so a menu rendered by
 * the same component must not be caught, or its first tap would be cancelled
 * (and with it the `<input switch>` toggle that plays the iOS haptic).
 */
export function useIosLongPress<Target>(
  onLongPress: (press: LongPress<Target>) => void,
  { enabled = true, resolve, mouse = true, onPressChange }: LongPressOptions<Target>,
) {
  // The latest callbacks, read when a timer or event lands, so the handlers
  // below keep one identity for the life of the element.
  const latest = useRef({ onLongPress, resolve, onPressChange });
  useLayoutEffect(() => {
    latest.current = { onLongPress, resolve, onPressChange };
  });

  const press = useRef<{
    target: Target;
    x: number;
    y: number;
    fire: ReturnType<typeof setTimeout>;
    feedback: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const fired = useRef(false);
  const clearFired = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlers = useMemo(() => {
    // Every path that ends a press goes through here, so a pending tint or
    // fire can never land after the finger has gone.
    const end = () => {
      const current = press.current;
      if (current === null) return;
      press.current = null;
      clearTimeout(current.fire);
      if (current.feedback !== null) clearTimeout(current.feedback);
      latest.current.onPressChange?.(null);
    };

    const begin = (element: Element, x: number, y: number, feedbackDelay: number) => {
      end();
      fired.current = false;
      const target = latest.current.resolve(element);
      if (target === null) return;
      const showFeedback = () => latest.current.onPressChange?.(target);
      press.current = {
        target,
        x,
        y,
        feedback: feedbackDelay > 0 ? setTimeout(showFeedback, feedbackDelay) : null,
        fire: setTimeout(() => {
          const current = press.current;
          if (current === null) return;
          fired.current = true;
          // UIKit plays a medium impact as a context menu lifts. Outside BB's
          // mobile app, Android browsers can still vibrate.
          if (
            !nativeHaptic("impact-medium") &&
            typeof navigator !== "undefined" &&
            "vibrate" in navigator
          ) {
            try {
              navigator.vibrate(10);
            } catch {}
          }
          // The press ends after the callback, which may want the target
          // as it looks while held.
          latest.current.onLongPress({ target: current.target, x: current.x, y: current.y });
          end();
        }, IOS_LONG_PRESS_MS),
      };
      if (feedbackDelay === 0) showFeedback();
    };

    const move = (x: number, y: number) => {
      const current = press.current;
      if (current === null) return;
      if (Math.hypot(x - current.x, y - current.y) > IOS_LONG_PRESS_ALLOWABLE_MOVEMENT_PX) end();
    };

    // Safari's synthetic click follows touchend at once when it comes at
    // all; a later click is a new tap and must go through.
    const release = () => {
      end();
      if (clearFired.current) clearTimeout(clearFired.current);
      clearFired.current = setTimeout(() => {
        fired.current = false;
      }, 300);
    };

    return {
      end,
      props: {
        onTouchStart: (event: TouchEvent<HTMLElement>) => {
          if (event.touches.length !== 1) return end();
          const touch = event.touches[0]!;
          begin(event.target as Element, touch.clientX, touch.clientY, TOUCH_PRESS_FEEDBACK_MS);
        },
        onTouchMove: (event: TouchEvent<HTMLElement>) => {
          const touch = event.touches[0];
          if (event.touches.length !== 1 || touch === undefined) end();
          else move(touch.clientX, touch.clientY);
        },
        onTouchEnd: release,
        onTouchCancel: release,
        onMouseMove: (event: MouseEvent<HTMLElement>) => move(event.clientX, event.clientY),
        onMouseUp: release,
        onMouseLeave: end,
        onClickCapture: (event: MouseEvent<HTMLElement>) => {
          if (!fired.current) return;
          if (!event.currentTarget.contains(event.target as Node)) return;
          fired.current = false;
          event.preventDefault();
          event.stopPropagation();
        },
      },
      onMouseDown: (event: MouseEvent<HTMLElement>) => {
        if (event.button === 0) begin(event.target as Element, event.clientX, event.clientY, 0);
      },
    };
  }, []);

  // A hold that outlives its handlers (disabled or unmounted) must not fire.
  const { end } = handlers;
  useEffect(() => {
    if (!enabled) end();
    return end;
  }, [enabled, end]);

  return useMemo(
    () =>
      enabled ? { ...handlers.props, ...(mouse ? { onMouseDown: handlers.onMouseDown } : {}) } : {},
    [enabled, mouse, handlers],
  );
}
