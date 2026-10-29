import { describe, expect, it } from "vitest";
import type { CatalogModel, CatalogProvider } from "./catalog";
import { buildTraits } from "./traits";

const provider = (supportsServiceTier: boolean) =>
  ({
    id: "claude-code",
    capabilities: { supportsServiceTier },
    serviceTiers: [
      { id: "default", label: "Default" },
      { id: "fast", label: "Fast", description: "Faster responses" },
    ],
  }) as unknown as CatalogProvider;

const model = (extra: object = {}) =>
  ({
    model: "claude-opus-5-5",
    supportedReasoningEfforts: [],
    ...extra,
  }) as unknown as CatalogModel;

const speedOf = (p: CatalogProvider, m: CatalogModel) =>
  buildTraits(p, m, { providerId: "claude-code", model: "claude-opus-5-5" }).speed;

describe("buildTraits speed", () => {
  it("offers the provider's tiers to a model that lists none, as BB does for Claude", () => {
    expect(speedOf(provider(true), model())).toMatchObject({
      kind: "toggle",
      tier: { id: "fast", label: "Fast", description: "Faster responses" },
      current: "default",
    });
  });

  it("narrows to the model's own list when it has one", () => {
    expect(speedOf(provider(true), model({ supportedServiceTiers: [] }))).toBeNull();
  });

  it("offers none when the provider does not support service tiers", () => {
    expect(speedOf(provider(false), model())).toBeNull();
  });
});
