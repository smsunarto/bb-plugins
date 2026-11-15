import { describe, expect, test } from "bun:test";
import { DEVICES, parseArgs } from "./phone-shot";

describe("phone-shot", () => {
  test("captures every device at a size frames-cli recognizes", () => {
    const frameSizes: Record<string, [number, number]> = {
      "iPhone 17 Pro Max Portrait": [1320, 2868],
      "iPhone 17 Pro Portrait": [1206, 2622],
      "iPhone 16 Portrait": [1179, 2556],
    };
    for (const device of Object.values(DEVICES)) {
      const { width, height, dpr } = device.viewport;
      expect([width * dpr, height * dpr]).toEqual(frameSizes[device.frame]!);
      expect(device.insets.bottom).toBeGreaterThan(0);
    }
  });

  test("parses start, shot, and stop", () => {
    expect(parseArgs(["start", "iphone-17-pro", "--session", "s", "--no-insets"])).toMatchObject({
      command: "start",
      device: "iphone-17-pro",
      session: "s",
      insets: false,
      minutes: 30,
    });
    expect(parseArgs(["start", "--session", "s"]).device).toBe("iphone-17-pro-max");
    expect(parseArgs(["shot", "--session", "s", "--out", "/tmp/x"]).out).toBe("/tmp/x");
    expect(parseArgs(["stop", "--session", "s"]).command).toBe("stop");
  });

  test("rejects missing or unknown input", () => {
    expect(() => parseArgs(["shot", "--session", "s"])).toThrow("--out");
    expect(() => parseArgs(["start", "pixel", "--session", "s"])).toThrow("Unknown device");
    expect(() => parseArgs(["start"])).toThrow("--session");
    expect(() => parseArgs(["frame"])).toThrow("Usage");
  });
});
