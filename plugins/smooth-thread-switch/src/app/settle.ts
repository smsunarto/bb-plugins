// When a switched-to conversation is safe to show.
//
// bb mounts the new thread's row list scrolled to the top and moves it into
// place a few frames later: to the bottom for a thread the reader last left
// there, or back to the row they had scrolled to. The latest rows can merge in
// and reflow once more after that. This module decides, frame by frame, when
// that settling is over. It is pure so it tests without a DOM; the content
// script feeds it live geometry.

export interface ScrollGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface HoldState {
  /** bb has placed the view: scrollTop moved, a scroll event landed, or nothing scrolls. */
  readonly positioned: boolean;
  /** Frames in a row whose geometry matched the frame before. */
  readonly stableFrames: number;
  readonly previous: ScrollGeometry | null;
}

export interface HoldStep {
  readonly state: HoldState;
  readonly reveal: boolean;
}

export const INITIAL_HOLD_STATE: HoldState = {
  positioned: false,
  stableFrames: 0,
  previous: null,
};

/** Matching frames needed once positioned. One means two identical samples. */
export const STABLE_FRAMES_TO_REVEAL = 1;
/** The longest hold. A thread still streaming, or restored to its very top, reveals here. */
export const HOLD_CAP_MS = 350;
/** Fractional scroll metrics leave a sub-pixel gap even when nothing can scroll. */
const FITS_THRESHOLD_PX = 4;

function fitsViewport(geometry: ScrollGeometry): boolean {
  return geometry.scrollHeight - geometry.clientHeight <= FITS_THRESHOLD_PX;
}

function sameGeometry(a: ScrollGeometry, b: ScrollGeometry): boolean {
  return (
    a.scrollTop === b.scrollTop &&
    a.scrollHeight === b.scrollHeight &&
    a.clientHeight === b.clientHeight
  );
}

/**
 * One frame of a hold. `elapsedMs` counts from the first sampled frame, and
 * `scrolled` is true once the scroll area has fired a scroll event.
 */
export function advanceHold(
  state: HoldState,
  geometry: ScrollGeometry,
  elapsedMs: number,
  scrolled: boolean,
): HoldStep {
  const positioned =
    state.positioned || scrolled || geometry.scrollTop > 0 || fitsViewport(geometry);
  const stableFrames =
    state.previous !== null && sameGeometry(state.previous, geometry) ? state.stableFrames + 1 : 0;
  const reveal =
    (positioned && stableFrames >= STABLE_FRAMES_TO_REVEAL) || elapsedMs >= HOLD_CAP_MS;
  return { state: { positioned, stableFrames, previous: geometry }, reveal };
}
