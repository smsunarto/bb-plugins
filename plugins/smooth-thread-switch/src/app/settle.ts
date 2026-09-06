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
  /** Rendered row positions, including horizontal and internal layout changes. */
  readonly layout: string;
}

export interface HoldState {
  /** bb has placed the view: scrollTop moved, a scroll event landed, or nothing scrolls. */
  readonly positioned: boolean;
  /** Start of the current interval with unchanged rendered geometry. */
  readonly stableSince: number;
  readonly previous: ScrollGeometry | null;
}

export interface HoldStep {
  readonly state: HoldState;
  readonly reveal: boolean;
}

export const INITIAL_HOLD_STATE: HoldState = {
  positioned: false,
  stableSince: 0,
  previous: null,
};

/** A quiet interval, independent of the display's refresh rate. */
export const SETTLE_QUIET_MS = 84;
/** Bound the delay for streams and views intentionally restored to the top. */
export const HOLD_CAP_MS = 800;
/** Fractional scroll metrics leave a sub-pixel gap even when nothing can scroll. */
const FITS_THRESHOLD_PX = 4;

function fitsViewport(geometry: ScrollGeometry): boolean {
  return geometry.scrollHeight - geometry.clientHeight <= FITS_THRESHOLD_PX;
}

function sameGeometry(a: ScrollGeometry, b: ScrollGeometry): boolean {
  return (
    a.scrollTop === b.scrollTop &&
    a.scrollHeight === b.scrollHeight &&
    a.clientHeight === b.clientHeight &&
    a.layout === b.layout
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
  const stableSince =
    state.previous !== null && sameGeometry(state.previous, geometry)
      ? state.stableSince
      : elapsedMs;
  const reveal =
    (positioned && elapsedMs - stableSince >= SETTLE_QUIET_MS) || elapsedMs >= HOLD_CAP_MS;
  return { state: { positioned, stableSince, previous: geometry }, reveal };
}
