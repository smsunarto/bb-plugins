// A port of Vimium's smooth scroller (philc/vimium, content_scripts/scroller.js,
// `CoreScroller.scroll`), trimmed to the one element this plugin scrolls.
//
// Each distinct key press starts its own animator, so several may run at once
// and two quick taps land where two slow taps would. An animator scrolls its
// relative `amount` over a duration derived from the distance, one instant
// `scrollBy` per animation frame. While the key that started it is still down,
// the animator keeps going past `amount` at a calibrated velocity: the
// calibration speeds up scrolls that look too slow and slows down the ones
// that look too fast.

/** The frame's share of the scroll, and the state that scales it. */
export interface ScrollFrameInput {
  amount: number;
  elapsed: number;
  duration: number;
  calibration: number;
  totalDelta: number;
  keyStillDown: boolean;
}

/** The intended scroll duration in ms. Longer scrolls get a bit longer. */
export function scrollDuration(amount: number): number {
  return Math.max(100, 20 * Math.log(Math.abs(amount)));
}

/** Controls how much a scroll may slow down. Smaller means more slow down. */
const MIN_CALIBRATION = 0.5;
/** Controls how much a scroll may speed up. Bigger means more speed up. */
const MAX_CALIBRATION = 1.6;
/** The boundary between scrolls counted as too slow and as too fast. */
const CALIBRATION_BOUNDARY = 150;

/**
 * The next calibration factor for a continuous scroll. It starts at 1.0 and
 * only moves while the key is held, after the scroll has run long enough to
 * judge, and while it stays inside its bounds.
 */
export function calibrate(
  calibration: number,
  amount: number,
  totalElapsed: number,
  keyStillDown: boolean,
): number {
  if (!keyStillDown || totalElapsed < 75) return calibration;
  if (calibration < MIN_CALIBRATION || calibration > MAX_CALIBRATION) return calibration;
  const size = Math.abs(amount);
  let next = calibration;
  if (1.05 * next * size < CALIBRATION_BOUNDARY) next *= 1.05;
  if (CALIBRATION_BOUNDARY < 0.95 * next * size) next *= 0.95;
  return next;
}

/**
 * How far this frame scrolls. It rounds up so every frame makes progress, and
 * stops at the requested amount once the key is up.
 */
export function frameDelta(input: ScrollFrameInput): number {
  const delta = Math.ceil(input.amount * (input.elapsed / input.duration) * input.calibration);
  if (input.keyStillDown) return delta;
  return Math.max(0, Math.min(delta, input.amount - input.totalDelta));
}

/** The keydown facts the scroller tracks. */
export interface KeyFact {
  readonly code: string;
  readonly repeat: boolean;
}

export interface Scroller {
  noteKeydown(key: KeyFact): void;
  noteKeyup(code: string): void;
  /** Ends every running animator's continuous phase, as a window blur does. */
  cancel(): void;
  scrollBy(area: HTMLElement, amount: number, continuous: boolean): void;
}

/**
 * A scroller whose animators run on `requestFrame`. Pass a pump to drive them
 * by hand.
 */
export function createScroller(
  requestFrame: (callback: (timestamp: number) => void) => void = (callback) => {
    window.requestAnimationFrame(callback);
  },
): Scroller {
  // A key is still down for an animator when no keydown, keyup, or blur has
  // landed since it started. Keyboard repeat starts no new animator, so the
  // running one keeps scrolling instead of restarting each repeat.
  let time = 0;
  let keyDownCode: string | null = null;
  let lastKeydownWasRepeat = false;

  return {
    noteKeydown(key: KeyFact): void {
      keyDownCode = key.code;
      lastKeydownWasRepeat = key.repeat;
      if (!key.repeat) time += 1;
    },

    noteKeyup(code: string): void {
      if (code !== keyDownCode) return;
      keyDownCode = null;
      time += 1;
    },

    cancel(): void {
      time += 1;
    },

    scrollBy(area: HTMLElement, amount: number, continuous: boolean): void {
      if (amount === 0 || lastKeydownWasRepeat) return;

      time += 1;
      const activationTime = time;
      const keyIsStillDown = (): boolean => time === activationTime && keyDownCode !== null;

      const sign = amount < 0 ? -1 : 1;
      const size = Math.abs(amount);
      const duration = scrollDuration(size);

      let totalDelta = 0;
      let totalElapsed = 0;
      let calibration = 1;
      let previousTimestamp: number | null = null;

      const animate = (timestamp: number): void => {
        if (previousTimestamp === null || timestamp === previousTimestamp) {
          previousTimestamp = timestamp;
          requestFrame(animate);
          return;
        }

        const elapsed = timestamp - previousTimestamp;
        totalElapsed += elapsed;
        previousTimestamp = timestamp;

        const keyStillDown = keyIsStillDown();
        calibration = calibrate(calibration, size, totalElapsed, keyStillDown);
        const delta = frameDelta({
          amount: size,
          elapsed,
          duration,
          calibration,
          totalDelta,
          keyStillDown,
        });
        if (delta === 0) return;

        const before = area.scrollTop;
        area.scrollBy({ top: sign * delta, behavior: "instant" });
        if (area.scrollTop === before) return;

        totalDelta += delta;
        requestFrame(animate);
      };

      // A non-continuous scroll advances time once more, so its own
      // key-still-down test always fails and it stops at `amount`.
      if (!continuous) time += 1;

      requestFrame(animate);
    },
  };
}
