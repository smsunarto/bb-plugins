import { describe, expect, it } from "vitest";
import {
  allowedPermissionModes,
  permissionModeOptions,
  resolvePermissionMode,
} from "./permission-modes";

const ALL = ["accept-edits", "auto", "full"] as const;

describe("permission modes", () => {
  it("allows the modes at or below the machine's ceiling", () => {
    expect(allowedPermissionModes(ALL, "auto")).toEqual(["accept-edits", "auto"]);
    expect(allowedPermissionModes(ALL, "full")).toEqual([...ALL]);
  });

  it("keeps an allowed value", () => {
    expect(resolvePermissionMode("accept-edits", ALL, "full")).toBe("accept-edits");
  });

  it("settles a value above the ceiling on Approve for me, as BB does", () => {
    expect(resolvePermissionMode("full", ALL, "auto")).toBe("auto");
  });

  it("falls back to Full Access, then the first mode, when Approve for me is not offered", () => {
    expect(resolvePermissionMode("auto", ["accept-edits", "full"], "full")).toBe("full");
    expect(resolvePermissionMode("full", ["accept-edits"], "accept-edits")).toBe("accept-edits");
  });

  it("uses the provider's modes when the ceiling allows none of them", () => {
    expect(resolvePermissionMode("auto", ["full"], "accept-edits")).toBe("full");
  });

  it("lists the provider's modes in BB's order, disabling those above the ceiling", () => {
    const options = permissionModeOptions(["full", "accept-edits"], "accept-edits");
    expect(options.map((option) => [option.value, option.disabled ?? false])).toEqual([
      ["accept-edits", false],
      ["full", true],
    ]);
  });
});
