import { describe, expect, test } from "bun:test";
import { machineColors } from "../lib/machine-colors";

const rosterOf = (size: number, seed: number) =>
  Array.from({ length: size }, (_, index) => `host_${(seed * 7919 + index * 104729).toString(36)}`);

const fixtureRoster = rosterOf(6, 42);

describe("machine colors", () => {
  test("keeps every ID stable when machines join or leave, including colliding IDs", () => {
    for (let seed = 0; seed < 200; seed++) {
      const roster = rosterOf(14, seed);
      const alone = machineColors([]);
      const together = machineColors(roster);
      expect(roster.map(together)).toEqual(roster.map(alone));
      for (const id of roster) expect(machineColors([id])(id)).toBe(alone(id));
    }
    expect(machineColors(["host-a", "host-g"])("host-g")).toBe(machineColors(["host-g"])("host-g"));
  });

  test("ignores roster order and duplicates", () => {
    const roster = rosterOf(5, 11);
    const forward = machineColors(roster);
    const shuffled = machineColors([...roster].reverse().concat(roster[0]!));
    expect(roster.map(shuffled)).toEqual(roster.map(forward));
  });

  test("moves no machine whose ID sorts before one that joins", () => {
    for (let seed = 0; seed < 200; seed++) {
      const roster = rosterOf(1 + (seed % 9), seed);
      const joining = `host_${(seed * 31337).toString(36)}`;
      const before = machineColors(roster);
      const after = machineColors([...roster, joining]);
      const earlier = roster.filter((hostId) => hostId < joining);
      expect(earlier.map(after)).toEqual(earlier.map(before));
    }
  });

  test("names theme identity tokens with fallbacks for other themes", () => {
    expect(new Set(rosterOf(100, 42).map(machineColors([])))).toEqual(
      new Set([
        "var(--machine-1, light-dark(#0c7cf4, #2987f8))",
        "var(--machine-2, light-dark(#358793, #07c3de))",
        "var(--machine-3, light-dark(#015e4e, #6dfee5))",
        "var(--machine-4, light-dark(#c52c7c, #fd7ec8))",
        "var(--machine-5, light-dark(#3d408a, #aaa0fb))",
        "var(--machine-6, light-dark(#85067c, #fec4ff))",
      ]),
    );
  });
});
