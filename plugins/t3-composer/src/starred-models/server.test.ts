import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../../server";
import { changeStarredModels, MAX_STARRED_MODELS } from "./contract";

const opus = { providerId: "claude-code", model: "claude-opus-5-5" };
const sol = { providerId: "codex", model: "gpt-6.1-sol" };

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "t3-composer" });
  await plugin(bb);
  return harness;
}

describe("starred models storage", () => {
  it("starts empty and keeps stars in the order they were added", async () => {
    const harness = await host();
    expect(await harness.behavior.callRpc("starredModels", null)).toEqual({ models: [] });
    await harness.behavior.callRpc("changeStarredModels", { add: [opus], remove: [] });
    await harness.behavior.callRpc("changeStarredModels", { add: [sol], remove: [] });
    expect(await harness.behavior.callRpc("starredModels", null)).toEqual({ models: [opus, sol] });
  });

  it("keeps both stars when two devices change the list at once", async () => {
    const harness = await host();
    await Promise.all([
      harness.behavior.callRpc("changeStarredModels", { add: [opus], remove: [] }),
      harness.behavior.callRpc("changeStarredModels", { add: [sol], remove: [] }),
    ]);
    expect(await harness.behavior.callRpc("starredModels", null)).toEqual({ models: [opus, sol] });
  });

  it("changes nothing when a change is repeated", async () => {
    const harness = await host();
    const change = { add: [opus], remove: [sol] };
    const first = await harness.behavior.callRpc("changeStarredModels", change);
    expect(await harness.behavior.callRpc("changeStarredModels", change)).toEqual(first);
    expect(first).toEqual({ models: [opus] });
  });

  it("refuses a list longer than the limit and keeps the stored one", async () => {
    const harness = await host();
    const many = Array.from({ length: MAX_STARRED_MODELS }, (_, index) => ({
      providerId: "codex",
      model: `model-${index}`,
    }));
    await harness.behavior.callRpc("changeStarredModels", { add: many, remove: [] });
    await expect(
      harness.behavior.callRpc("changeStarredModels", { add: [opus], remove: [] }),
    ).rejects.toThrow(/up to 200 models/u);
    const stored = (await harness.behavior.callRpc("starredModels", null)) as { models: unknown[] };
    expect(stored.models).toHaveLength(MAX_STARRED_MODELS);
  });
});

describe("changeStarredModels", () => {
  it("returns the same list when nothing changes", () => {
    const current = [opus];
    expect(changeStarredModels(current, { add: [opus], remove: [sol] })).toBe(current);
  });

  it("lets a removal win over an addition of the same model", () => {
    expect(changeStarredModels([opus], { add: [opus], remove: [opus] })).toEqual([]);
  });
});
