import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { reviewWorktree } from "./review-environment";

const target = { number: 1125, headRefOid: "3".repeat(40) };

it("creates a native worktree at the dispatched PR head on the selected host", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  try {
    expect(await reviewWorktree(bb, { type: "host", hostId: "host_remote" }, target)).toEqual({
      type: "provider",
      environmentProviderId: "slopcop-review",
      machine: { type: "existing", hostId: "host_remote" },
      inputs: { number: 1125, head: "3".repeat(40) },
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("resolves the existing environment's host without reusing its checkout", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  harness.sdk.stub("environments.get", () => ({ hostId: "host_existing" }));
  try {
    expect(
      await reviewWorktree(bb, { type: "reuse", environmentId: "env_existing" }, target),
    ).toMatchObject({
      type: "provider",
      environmentProviderId: "slopcop-review",
      machine: { type: "existing", hostId: "host_existing" },
      inputs: { number: 1125, head: "3".repeat(40) },
    });
    expect(harness.sdk.callsTo("environments.get")[0]?.[0]).toEqual({
      environmentId: "env_existing",
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("uses BB's default host when the rule has no host selection", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  try {
    expect(await reviewWorktree(bb, undefined, target)).toEqual({
      type: "provider",
      environmentProviderId: "slopcop-review",
      inputs: { number: 1125, head: "3".repeat(40) },
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("preserves a new machine and its warm-image inputs while selecting a worktree", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  const machine = {
    type: "new" as const,
    machineProviderId: "boat-sandbox",
    inputs: { type: "large", from: "rampage-client-review-5" },
  };
  try {
    expect(
      await reviewWorktree(
        bb,
        {
          type: "provider",
          environmentProviderId: "boat-sandbox",
          inputs: {},
          machine,
        },
        target,
      ),
    ).toEqual({
      type: "provider",
      environmentProviderId: "slopcop-review",
      machine,
      inputs: { number: 1125, head: "3".repeat(40) },
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});
