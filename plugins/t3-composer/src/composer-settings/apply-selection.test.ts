import { describe, expect, it } from "vitest";
import { applySelection, refusedSettingMessage } from "./apply-selection";

describe("refusedSettingMessage", () => {
  it("reports a value BB reconciled away", () => {
    expect(refusedSettingMessage({ permissionMode: "full" }, { permissionMode: "auto" })).toBe(
      "BB kept the current permission mode.",
    );
    expect(
      refusedSettingMessage({ reasoningLevel: "high" }, { reasoningLevel: "high" }),
    ).toBeNull();
  });
});

describe("applySelection", () => {
  it("reports what BB applied and why it differs from the request", async () => {
    const composer = { setSelection: async () => ({ reasoningLevel: "medium" as const }) };
    expect(await applySelection(composer, { reasoningLevel: "high" })).toEqual({
      applied: { reasoningLevel: "medium" },
      error: "This model does not support that effort.",
    });
  });

  it("turns a refusal into a message instead of rejecting", async () => {
    const composer = {
      setSelection: async () => {
        throw new Error("This composer has no pickers.");
      },
    };
    expect(await applySelection(composer, { model: "opus" })).toEqual({
      applied: null,
      error: "This composer has no pickers.",
    });
  });
});
