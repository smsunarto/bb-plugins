import { describe, expect, test } from "bun:test";
import {
  HOLD_CAP_MS,
  INITIAL_HOLD_STATE,
  advanceHold,
  type HoldState,
  type ScrollGeometry,
} from "./settle.ts";

const FRAME_MS = 16;

/** Feeds frames in order and returns the frame index that revealed, or null. */
function revealFrame(frames: readonly ScrollGeometry[], scrolledFrom = Infinity): number | null {
  let state: HoldState = INITIAL_HOLD_STATE;
  for (const [index, geometry] of frames.entries()) {
    const step = advanceHold(state, geometry, index * FRAME_MS, index >= scrolledFrom);
    state = step.state;
    if (step.reveal) return index;
  }
  return null;
}

const atTop: ScrollGeometry = { scrollTop: 0, scrollHeight: 2881, clientHeight: 1069 };
const atBottom: ScrollGeometry = { scrollTop: 1812, scrollHeight: 2881, clientHeight: 1069 };

describe("advanceHold", () => {
  test("waits through the top-scrolled frames, then reveals one quiet frame after the snap", () => {
    // bb's bottom restore lands a few frames after mount; the reveal follows
    // the first frame that repeats the snapped geometry.
    expect(revealFrame([atTop, atTop, atTop, atBottom, atBottom])).toBe(4);
  });

  test("keeps holding while the snapped geometry is still changing", () => {
    const merged: ScrollGeometry = { scrollTop: 1837, scrollHeight: 2906, clientHeight: 1069 };
    expect(revealFrame([atTop, atBottom, merged, merged])).toBe(3);
  });

  test("a scroll event counts as positioning", () => {
    expect(revealFrame([atTop, atTop, atTop], 1)).toBe(1);
  });

  test("a conversation that fits its viewport reveals after one quiet frame", () => {
    const fits: ScrollGeometry = { scrollTop: 0, scrollHeight: 1069, clientHeight: 1069 };
    const nearlyFits: ScrollGeometry = { scrollTop: 0, scrollHeight: 1072, clientHeight: 1069 };
    expect(revealFrame([fits, fits])).toBe(1);
    expect(revealFrame([nearlyFits, nearlyFits])).toBe(1);
  });

  test("a view left at its very top reveals at the cap", () => {
    const frames = Array.from({ length: 30 }, () => atTop);
    const revealed = revealFrame(frames);
    expect(revealed).not.toBeNull();
    expect((revealed ?? 0) * FRAME_MS).toBeGreaterThanOrEqual(HOLD_CAP_MS);
    expect(((revealed ?? 0) - 1) * FRAME_MS).toBeLessThan(HOLD_CAP_MS);
  });

  test("a streaming thread that never settles reveals at the cap", () => {
    const frames = Array.from({ length: 30 }, (_, index) => ({
      scrollTop: 1812 + index * 12,
      scrollHeight: 2881 + index * 12,
      clientHeight: 1069,
    }));
    expect(revealFrame(frames)).toBe(Math.ceil(HOLD_CAP_MS / FRAME_MS));
  });

  test("stability restarts when any metric moves, including the viewport", () => {
    const resized: ScrollGeometry = { ...atBottom, clientHeight: 900 };
    expect(revealFrame([atBottom, resized, resized])).toBe(2);
  });
});
