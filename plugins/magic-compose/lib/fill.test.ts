import { describe, expect, it } from "vitest";
import type { DecisionSummary } from "../server";
import { changedSelection, selectionFor } from "./fill";

const pick = (label: string) => ({
  label,
  source: "jev" as const,
  probability: 0.9,
  confidence: 0.9,
  alternatives: [],
});

const decision: DecisionSummary = {
  project: { ...pick("bb"), id: "proj_bb" },
  machine: { ...pick("bee"), id: "host_bee" },
  model: { ...pick("Fable"), providerId: "claude-code", model: "fable" },
  reasoning: pick("max"),
  environment: { ...pick("Worktree"), id: "git-worktree" },
  latencyMs: 300,
  timings: [],
};

const ALL = { project: true, placement: true, model: true, effort: true };

describe("selectionFor", () => {
  it("asks for the decision's project, machine, environment, model, and effort", () => {
    expect(selectionFor(decision, ALL)).toEqual({
      projectId: "proj_bb",
      environment: {
        type: "provider",
        environmentProviderId: "git-worktree",
        inputs: {},
        machine: { type: "existing", hostId: "host_bee" },
      },
      providerId: "claude-code",
      model: "fable",
      reasoningLevel: "max",
    });
  });

  it("leaves permission mode to the user", () => {
    expect(selectionFor(decision, ALL)).not.toHaveProperty("permissionMode");
  });

  it("refuses a reasoning level BB does not know", () => {
    expect(() => selectionFor({ ...decision, reasoning: pick("galaxy") }, ALL)).toThrow(/unknown/);
  });

  it("leaves out the pickers Magic Compose may not set", () => {
    expect(selectionFor(decision, { ...ALL, project: false })).not.toHaveProperty("projectId");
    expect(selectionFor(decision, { ...ALL, placement: false })).not.toHaveProperty("environment");
    expect(selectionFor(decision, { ...ALL, effort: false })).toEqual(
      expect.not.objectContaining({ reasoningLevel: expect.anything() }),
    );
    // No model, so no effort either: Jev chose the effort for its own model.
    expect(selectionFor(decision, { ...ALL, model: false })).toEqual({
      projectId: "proj_bb",
      environment: expect.anything(),
    });
    expect(
      selectionFor(decision, { project: false, placement: false, model: false, effort: false }),
    ).toEqual({});
  });
});

describe("changedSelection", () => {
  const first = selectionFor(decision, ALL);

  it("sets everything the first time", () => {
    expect(changedSelection(null, first)).toEqual(first);
  });

  it("sets nothing when Jev's answer is unchanged, leaving hand-made changes alone", () => {
    expect(changedSelection(first, selectionFor(decision, ALL))).toEqual({});
  });

  it("sets only the model and effort when only they changed", () => {
    const next = selectionFor({ ...decision, reasoning: pick("low") }, ALL);
    expect(changedSelection(first, next)).toEqual({
      providerId: "claude-code",
      model: "fable",
      reasoningLevel: "low",
    });
  });

  it("sets only the model when effort is not Magic Compose's to set", () => {
    const sets = { ...ALL, effort: false };
    const before = selectionFor(decision, sets);
    const after = selectionFor(
      { ...decision, model: { ...pick("Astra"), providerId: "codex", model: "astra" } },
      sets,
    );
    expect(changedSelection(before, after)).toEqual({ providerId: "codex", model: "astra" });
  });

  it("sets everything again when the project, machine, or environment moves", () => {
    for (const moved of [
      { ...decision, project: { ...pick("plugins"), id: "proj_plugins" } },
      { ...decision, machine: { ...pick("mac"), id: "host_mac" } },
      { ...decision, environment: { ...pick("Checkout"), id: "project-checkout" } },
    ]) {
      const next = selectionFor(moved, ALL);
      expect(changedSelection(first, next)).toEqual(next);
    }
  });
});
