import { describe, expect, test } from "bun:test";
import {
  animationTime,
  frameCount,
  frameTime,
  modeAvailability,
  parseShotScript,
  reviewModes,
  rulerTicks,
} from "./model-review.ts";

describe("model review scripts", () => {
  test("static models retain useful modes and explain unavailable diagnostics", () => {
    const modes = modeAvailability({
      skin: false,
      uv: false,
      normals: false,
      normalMap: false,
      aoMap: false,
    });
    expect(modes.find((mode) => mode.id === "skeleton")?.reason).toBe("No skin");
    expect(modes.find((mode) => mode.id === "uv")?.reason).toBe("No UV0");
    expect(modes.find((mode) => mode.id === "uv-layout")?.reason).toBe("No UV0");
    expect(modes.find((mode) => mode.id === "shaded")?.reason).toBeNull();
    expect(modes.find((mode) => mode.id === "metallic")?.reason).toBeNull();
    expect(
      modeAvailability({ skin: true, uv: true, normals: true, normalMap: true, aoMap: true }).every(
        (mode) => !mode.reason,
      ),
    ).toBe(true);
  });
  test("packed ORM channels stay associated with the material property", () => {
    expect(reviewModes.find((mode) => mode.id === "metallic")).toMatchObject({
      map: "metalnessMap",
      channel: 2,
    });
    expect(reviewModes.find((mode) => mode.id === "roughness")).toMatchObject({
      map: "roughnessMap",
      channel: 1,
    });
    expect(reviewModes.find((mode) => mode.id === "occlusion")).toMatchObject({
      map: "aoMap",
      channel: 0,
    });
  });
  test("a minimal shot gets safe deterministic defaults", () => {
    expect(parseShotScript('{"shots":[{"name":"front"}]}')).toEqual({
      width: 1280,
      height: 720,
      shots: [{ name: "front", mode: "shaded", camera: "three-quarter", joint: 0 }],
    });
  });
  test("rejects traversal, duplicate names and unknown modes/fields", () => {
    for (const shots of [
      [{ name: "../outside" }],
      [{ name: "a" }, { name: "a" }],
      [{ name: "a", mode: "typo" }],
      [{ name: "a", url: "http://other-site" }],
    ])
      expect(() => parseShotScript({ shots })).toThrow();
  });
  test("bounds capture costs and rejects fractional sizes and invalid timing", () => {
    for (const video of [
      { duration: 0, fps: 24 },
      { duration: 3, fps: 0 },
      { duration: Infinity, fps: 24 },
    ])
      expect(() => parseShotScript({ shots: [{ name: "a", video }] })).toThrow();
    expect(() =>
      parseShotScript({ width: 101, shots: [{ name: "a", video: { duration: 1 } }] }),
    ).toThrow();
    expect(() =>
      parseShotScript({
        width: 2048,
        height: 2048,
        shots: [{ name: "a", video: { duration: 30, fps: 60 } }],
      }),
    ).toThrow();
  });
  test("fixed timestamps do not depend on render speed", () => {
    expect(frameCount({ duration: 1.6, fps: 24 })).toBe(39);
    expect(frameCount()).toBe(1);
    expect(frameTime(23, 24)).toBe(23 / 24);
    expect(animationTime(2.1, 1.6, true)).toBeCloseTo(0.5);
    expect(animationTime(2.1, 1.6, false)).toBe(1.6);
    expect(animationTime(10, 0, true)).toBe(0);
  });
});

describe("timeline ruler", () => {
  test("labels a clip on a round step with fewer than seven ticks", () => {
    expect(rulerTicks(1.6)).toEqual([0, 0.5, 1, 1.5]);
    expect(rulerTicks(7.3)).toEqual([0, 2, 4, 6]);
    expect(rulerTicks(600)).toEqual([0, 120, 240, 360, 480, 600]);
    expect(rulerTicks(0.05)).toEqual([0]);
    expect(rulerTicks(0.3)).toEqual([0, 0.1, 0.2, 0.3]);
  });
});
