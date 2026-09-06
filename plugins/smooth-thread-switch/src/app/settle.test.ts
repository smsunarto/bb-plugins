import { describe, expect, test } from "bun:test";
import {
  HOLD_CAP_MS,
  INITIAL_HOLD_STATE,
  SETTLE_QUIET_MS,
  advanceHold,
  type ScrollGeometry,
} from "./settle.ts";

const top: ScrollGeometry = {
  scrollTop: 0,
  scrollHeight: 2881,
  clientHeight: 1069,
  layout: "initial",
};
const bottom: ScrollGeometry = { ...top, scrollTop: 1812, layout: "positioned" };

describe("advanceHold", () => {
  test("covers the observed pause before the footer begins changing height", () => {
    let step = advanceHold(INITIAL_HOLD_STATE, bottom, 0, false);
    step = advanceHold(step.state, bottom, 66, false);
    expect(step.reveal).toBe(false);
    const footer = { ...bottom, scrollHeight: bottom.scrollHeight + 20 };
    step = advanceHold(step.state, footer, 83, false);
    expect(step.reveal).toBe(false);
    expect(advanceHold(step.state, footer, 83 + SETTLE_QUIET_MS, false).reveal).toBe(true);
  });

  test("a brief pause before a delayed reflow does not reveal the intermediate layout", () => {
    let step = advanceHold(INITIAL_HOLD_STATE, top, 0, false);
    step = advanceHold(step.state, bottom, 16, false);
    step = advanceHold(step.state, bottom, 48, false);
    expect(step.reveal).toBe(false);
    const reflow = { ...bottom, scrollHeight: 3100, scrollTop: 2031 };
    step = advanceHold(step.state, reflow, 96, false);
    step = advanceHold(step.state, reflow, 96 + SETTLE_QUIET_MS - 1, false);
    expect(step.reveal).toBe(false);
    expect(advanceHold(step.state, reflow, 96 + SETTLE_QUIET_MS, false).reveal).toBe(true);
  });

  test("row movement restarts stability even when all scroll metrics are unchanged", () => {
    let step = advanceHold(INITIAL_HOLD_STATE, bottom, 0, false);
    const shifted = { ...bottom, layout: "rows-reflowed" };
    step = advanceHold(step.state, shifted, 100, false);
    expect(advanceHold(step.state, shifted, 120, false).reveal).toBe(false);
    expect(advanceHold(step.state, shifted, 220, false).reveal).toBe(true);
  });

  test("quiet time is independent of refresh rate", () => {
    for (const frameMs of [8, 16, 33]) {
      let state = INITIAL_HOLD_STATE;
      for (let time = 0; time < SETTLE_QUIET_MS; time += frameMs) {
        const step = advanceHold(state, bottom, time, false);
        expect(step.reveal).toBe(false);
        state = step.state;
      }
      expect(advanceHold(state, bottom, SETTLE_QUIET_MS, false).reveal).toBe(true);
    }
  });

  test("a scroll event allows a view restored to the top to settle", () => {
    const step = advanceHold(INITIAL_HOLD_STATE, top, 0, true);
    expect(advanceHold(step.state, top, SETTLE_QUIET_MS, true).reveal).toBe(true);
  });

  test("content fitting the viewport waits for layout stability too", () => {
    const fits = { ...top, scrollHeight: 1072 };
    const step = advanceHold(INITIAL_HOLD_STATE, fits, 0, false);
    expect(advanceHold(step.state, fits, SETTLE_QUIET_MS - 1, false).reveal).toBe(false);
    expect(advanceHold(step.state, fits, SETTLE_QUIET_MS, false).reveal).toBe(true);
  });

  test("streaming or a view left at the top cannot hold forever", () => {
    for (const geometry of [top, bottom]) {
      const step = advanceHold(INITIAL_HOLD_STATE, geometry, 0, false);
      const changed = { ...geometry, layout: "still-changing" };
      expect(advanceHold(step.state, changed, HOLD_CAP_MS - 1, false).reveal).toBe(false);
      expect(advanceHold(step.state, changed, HOLD_CAP_MS, false).reveal).toBe(true);
    }
  });
});
