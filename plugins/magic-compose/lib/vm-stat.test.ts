import { describe, expect, it } from "vitest";
import { parseVmStatAvailableBytes } from "./vm-stat";

const SAMPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            400000.
Pages inactive:                          300000.
Pages speculative:                         5000.
Pages wired down:                        150000.
Pages purgeable:                           2000.
`;

describe("parseVmStatAvailableBytes", () => {
  it("counts free and reclaimable pages", () => {
    expect(parseVmStatAvailableBytes(SAMPLE)).toBe((10000 + 300000 + 5000 + 2000) * 16384);
  });

  it("returns null for output it does not recognize", () => {
    expect(parseVmStatAvailableBytes("command not found")).toBeNull();
  });
});
