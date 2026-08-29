import assert from "node:assert/strict";
import { test } from "bun:test";
import { validatePluginProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import server from "../server/server.ts";
import { nanocodexProvider } from "../server/provider-declaration.ts";
import {
  NANOCODEX_MODELS,
  NANOCODEX_REASONING_LEVELS,
} from "../src/catalog.ts";

test("the provider declaration preserves NanoCodex models, reasoning, fast tier, and checkpoint fork", () => {
  const provider = validatePluginProviderDeclaration(nanocodexProvider);
  assert.equal(provider.id, "nanocodex");
  assert.deepEqual(provider.capabilities.reasoningLevels, NANOCODEX_REASONING_LEVELS);
  assert.equal(provider.capabilities.fork, "checkpoint");
  assert.equal(provider.capabilities.supportsManualCompaction, true);
  assert.deepEqual(provider.models, { scope: "host", fallback: NANOCODEX_MODELS });
  assert.deepEqual(provider.serviceTiers?.map((tier) => tier.id), ["default", "fast"]);
  assert.deepEqual(provider.maintenance, { health: true, usage: false, installation: false });
});

test("the server is one bb-kit composition root that registers the SDK provider", async () => {
  let registered: unknown;
  const bb = {
    rpc: { register() {} },
    cli: { register() {} },
    providers: { register(provider: unknown) { registered = provider; } },
    storage: { kv: {} },
    sdk: {},
  };
  await server(bb as never);
  assert.equal(registered, nanocodexProvider);
});
