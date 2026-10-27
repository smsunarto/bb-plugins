import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  preferencesPatchSchema,
  preferencesSchema,
  readStoredPreferences,
} from "./preferences";

describe("preferencesPatchSchema", () => {
  it("carries only the fields it was given, so a save cannot reset the others", () => {
    expect(preferencesPatchSchema.parse({ holdSend: false })).toEqual({ holdSend: false });
    expect(preferencesPatchSchema.parse({ modelInstructions: "Use Fable." })).toEqual({
      modelInstructions: "Use Fable.",
    });
    expect(preferencesPatchSchema.parse({})).toEqual({});
  });

  it("merges over what is stored without touching the rest", () => {
    const stored = {
      ...DEFAULT_PREFERENCES,
      modelInstructions: "Use Fable.",
      pace: "pause" as const,
    };
    const patch = preferencesPatchSchema.parse({ holdSend: false });
    expect(preferencesSchema.parse({ ...stored, ...patch })).toEqual({
      ...stored,
      holdSend: false,
    });
  });

  it("refuses a field it does not know and a value out of range", () => {
    expect(preferencesPatchSchema.safeParse({ nonsense: true }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ pace: "never" }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ modelInstructions: "x".repeat(4_001) }).success).toBe(
      false,
    );
  });
});

describe("readStoredPreferences", () => {
  it("gives the defaults when nothing is stored", () => {
    expect(readStoredPreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(readStoredPreferences("nonsense")).toEqual(DEFAULT_PREFERENCES);
  });

  it("keeps what is stored and fills in a preference added since", () => {
    const { pace: _pace, ...older } = { ...DEFAULT_PREFERENCES, modelInstructions: "Use Fable." };
    expect(readStoredPreferences({ ...older, maySet: { project: false } })).toEqual({
      ...DEFAULT_PREFERENCES,
      modelInstructions: "Use Fable.",
      maySet: { ...DEFAULT_PREFERENCES.maySet, project: false },
    });
  });
});
