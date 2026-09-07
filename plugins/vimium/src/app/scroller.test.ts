import { describe, expect, test } from "bun:test";
import { calibrate, createScroller, frameDelta, scrollDuration } from "./scroller.ts";

interface FakeArea {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrolls: number[];
  scrollBy(options: { top?: number; behavior?: string }): void;
}

/** A scrollable area that clamps like a real one, and records what it took. */
function fakeArea(scrollHeight = 100_000): FakeArea {
  const area: FakeArea = {
    scrollTop: 0,
    scrollHeight,
    clientHeight: 400,
    scrolls: [],
    scrollBy(options) {
      const max = Math.max(0, area.scrollHeight - area.clientHeight);
      area.scrolls.push(options.top ?? 0);
      area.scrollTop = Math.max(0, Math.min(area.scrollTop + (options.top ?? 0), max));
    },
  };
  return area;
}

/** A hand-driven replacement for requestAnimationFrame, one frame per 16ms. */
function framePump(): {
  requestFrame: (callback: (t: number) => void) => void;
  run: (frames: number) => void;
} {
  let pending: Array<(timestamp: number) => void> = [];
  let now = 0;
  return {
    requestFrame(callback) {
      pending.push(callback);
    },
    run(frames) {
      for (let index = 0; index < frames; index += 1) {
        const due = pending;
        pending = [];
        now += 16;
        for (const callback of due) callback(now);
      }
    },
  };
}

describe("scrollDuration", () => {
  test("a short scroll takes the 100ms floor, a long one takes longer", () => {
    expect(scrollDuration(60)).toBe(100);
    expect(scrollDuration(-60)).toBe(100);
    expect(scrollDuration(3000)).toBeCloseTo(20 * Math.log(3000), 6);
    expect(scrollDuration(3000)).toBeCloseTo(160.1, 1);
  });
});

describe("frameDelta", () => {
  const frame = { amount: 60, elapsed: 16, duration: 100, calibration: 1, totalDelta: 0 };

  test("a frame's share rounds up so every frame makes progress", () => {
    expect(frameDelta({ ...frame, keyStillDown: true })).toBe(10);
    expect(frameDelta({ ...frame, elapsed: 1, keyStillDown: true })).toBe(1);
  });

  test("calibration scales the share", () => {
    expect(frameDelta({ ...frame, calibration: 1.6, keyStillDown: true })).toBe(16);
  });

  test("a key that is up clamps the share to what is left", () => {
    expect(frameDelta({ ...frame, totalDelta: 55, keyStillDown: false })).toBe(5);
    expect(frameDelta({ ...frame, totalDelta: 60, keyStillDown: false })).toBe(0);
    expect(frameDelta({ ...frame, totalDelta: 200, keyStillDown: false })).toBe(0);
  });

  test("a key that is still down keeps scrolling past the amount", () => {
    expect(frameDelta({ ...frame, totalDelta: 55, keyStillDown: true })).toBe(10);
    expect(frameDelta({ ...frame, totalDelta: 200, keyStillDown: true })).toBe(10);
  });
});

describe("calibrate", () => {
  test("nothing changes before the scroll has run 75ms", () => {
    expect(calibrate(1, 60, 74, true)).toBe(1);
  });

  test("nothing changes once the key is up", () => {
    expect(calibrate(1, 60, 200, false)).toBe(1);
  });

  test("a short step speeds up and a long one slows down", () => {
    expect(calibrate(1, 60, 75, true)).toBeCloseTo(1.05, 10);
    expect(calibrate(1, 400, 75, true)).toBeCloseTo(0.95, 10);
  });

  test("a step already at the boundary stays put", () => {
    expect(calibrate(1, 150, 200, true)).toBe(1);
  });

  test("a calibration outside its bounds freezes", () => {
    expect(calibrate(0.4, 60, 200, true)).toBe(0.4);
    expect(calibrate(1.7, 60, 200, true)).toBe(1.7);
  });
});

describe("createScroller", () => {
  test("one tap scrolls exactly one step and stops", () => {
    const pump = framePump();
    const scroller = createScroller(pump.requestFrame);
    const area = fakeArea();

    scroller.noteKeydown({ code: "KeyJ", repeat: false });
    scroller.scrollBy(area as unknown as HTMLElement, 60, true);
    scroller.noteKeyup("KeyJ");
    pump.run(40);

    expect(area.scrollTop).toBe(60);
    expect(area.scrolls.length).toBeGreaterThan(1);
    expect(area.scrolls.reduce((sum, top) => sum + top, 0)).toBe(60);
  });

  test("an upward tap scrolls back the same distance", () => {
    const pump = framePump();
    const scroller = createScroller(pump.requestFrame);
    const area = fakeArea();
    area.scrollTop = 500;

    scroller.noteKeydown({ code: "KeyK", repeat: false });
    scroller.scrollBy(area as unknown as HTMLElement, -60, true);
    scroller.noteKeyup("KeyK");
    pump.run(40);

    expect(area.scrollTop).toBe(440);
  });

  test("two taps before a single frame add up to two steps", () => {
    const pump = framePump();
    const scroller = createScroller(pump.requestFrame);
    const area = fakeArea();

    for (const _tap of [0, 1]) {
      scroller.noteKeydown({ code: "KeyJ", repeat: false });
      scroller.scrollBy(area as unknown as HTMLElement, 60, true);
      scroller.noteKeyup("KeyJ");
    }
    pump.run(40);

    expect(area.scrollTop).toBe(120);
  });

  test("a held key scrolls past one step until the keyup lands", () => {
    const pump = framePump();
    const scroller = createScroller(pump.requestFrame);
    const area = fakeArea();

    scroller.noteKeydown({ code: "KeyJ", repeat: false });
    scroller.scrollBy(area as unknown as HTMLElement, 60, true);
    pump.run(30);

    expect(area.scrollTop).toBeGreaterThan(200);

    const held = area.scrollTop;
    scroller.noteKeyup("KeyJ");
    pump.run(5);

    expect(area.scrollTop).toBe(held);
  });

  test("a keyboard repeat starts no second animator", () => {
    const pump = framePump();
    const scroller = createScroller(pump.requestFrame);
    const area = fakeArea();

    scroller.noteKeydown({ code: "KeyJ", repeat: true });
    scroller.scrollBy(area as unknown as HTMLElement, 60, true);
    pump.run(40);

    expect(area.scrolls).toEqual([]);
    expect(area.scrollTop).toBe(0);
  });

  test("a blur ends the held scroll the way a keyup does", () => {
    const pump = framePump();
    const scroller = createScroller(pump.requestFrame);
    const area = fakeArea();

    scroller.noteKeydown({ code: "KeyJ", repeat: false });
    scroller.scrollBy(area as unknown as HTMLElement, 60, true);
    pump.run(10);
    const held = area.scrollTop;

    scroller.cancel();
    pump.run(5);

    expect(area.scrollTop).toBe(held);
    expect(held).toBeGreaterThan(60);
  });

  test("a non-continuous scroll ignores a held key and stops at the amount", () => {
    const pump = framePump();
    const scroller = createScroller(pump.requestFrame);
    const area = fakeArea();

    scroller.noteKeydown({ code: "KeyJ", repeat: false });
    scroller.scrollBy(area as unknown as HTMLElement, 600, false);
    pump.run(60);

    expect(area.scrollTop).toBe(600);
  });

  test("an animator stops as soon as the area no longer moves", () => {
    const pump = framePump();
    const scroller = createScroller(pump.requestFrame);
    const area = fakeArea(1000);
    area.scrollTop = 600;

    scroller.noteKeydown({ code: "KeyJ", repeat: false });
    scroller.scrollBy(area as unknown as HTMLElement, 60, true);
    pump.run(40);

    expect(area.scrollTop).toBe(600);
    expect(area.scrolls).toEqual([10]);
  });

  test("a zero amount starts nothing", () => {
    const pump = framePump();
    const scroller = createScroller(pump.requestFrame);
    const area = fakeArea();

    scroller.noteKeydown({ code: "KeyJ", repeat: false });
    scroller.scrollBy(area as unknown as HTMLElement, 0, false);
    pump.run(10);

    expect(area.scrolls).toEqual([]);
  });
});
