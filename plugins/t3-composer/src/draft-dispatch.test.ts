import { describe, expect, it } from "vitest";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { draftDispatchDecision } from "./draft-dispatch";

const pluginId = "t3-composer";
const decide = (overrides: Parameters<typeof makeMessageDispatchHookContext>[0] = {}) =>
  draftDispatchDecision({ pluginId, context: makeMessageDispatchHookContext(overrides) });

describe("Save draft dispatch", () => {
  it("holds a Save draft submission instead of starting a turn", () => {
    expect(decide({ experimental_submission: { pluginId, data: { kind: "draft" } } })).toEqual({
      action: "wait",
      reason: "Draft",
    });
  });

  it("keeps a saved draft held when the queue is rechecked", () => {
    expect(
      decide({ queuedMessages: [{ waitingOn: { kind: "plugin", pluginId, reason: "Draft" } }] }),
    ).toEqual({ action: "wait", reason: "Draft" });
  });

  it("lets an ordinary send proceed", () => {
    expect(decide()).toEqual({ action: "proceed" });
  });

  it("leaves another plugin's draft to its owning hook", () => {
    expect(
      decide({ experimental_submission: { pluginId: "drafts", data: { kind: "draft" } } }),
    ).toEqual({ action: "proceed" });
    expect(
      decide({
        queuedMessages: [{ waitingOn: { kind: "plugin", pluginId: "drafts", reason: "Draft" } }],
      }),
    ).toEqual({ action: "proceed" });
  });

  it("does not hold a regular message merely because a later queued row is a draft", () => {
    expect(
      decide({
        queuedMessages: [
          { waitingOn: null },
          { waitingOn: { kind: "plugin", pluginId, reason: "Draft" } },
        ],
      }),
    ).toEqual({ action: "proceed" });
  });

  it.each([null, "draft", ["draft"], { kind: "other" }])(
    "ignores unrelated submission metadata %j",
    (data) => {
      expect(decide({ experimental_submission: { pluginId, data } })).toEqual({
        action: "proceed",
      });
    },
  );
});
