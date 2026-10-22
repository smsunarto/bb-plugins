import { describe, expect, test } from "bun:test";
import { machineColors } from "../lib/machine-colors";

const rosterOf = (size: number, seed: number) =>
  Array.from({ length: size }, (_, index) => `host_${(seed * 7919 + index * 104729).toString(36)}`);

const fixtureRoster = rosterOf(6, 42);

describe("machine colors", () => {
  test("gives each of six fixture machines its own color", () => {
    const colorOf = machineColors(fixtureRoster);
    expect(new Set(fixtureRoster.map(colorOf)).size).toBe(6);
  });

  test("never repeats a color until the roster outgrows the palette", () => {
    for (let seed = 0; seed < 200; seed++) {
      for (let size = 1; size <= 6; size++) {
        const roster = rosterOf(size, seed);
        const colorOf = machineColors(roster);
        expect(new Set(roster.map(colorOf)).size).toBe(size);
      }
    }
  });

  test("spreads a larger roster evenly over the palette", () => {
    const roster = rosterOf(14, 3);
    const colorOf = machineColors(roster);
    const uses = new Map<string, number>();
    for (const hostId of roster) uses.set(colorOf(hostId), (uses.get(colorOf(hostId)) ?? 0) + 1);
    expect(uses.size).toBe(6);
    expect(Math.max(...uses.values())).toBe(3);
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
    expect(new Set(fixtureRoster.map(machineColors(fixtureRoster)))).toEqual(
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
