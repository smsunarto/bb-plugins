import { test } from "node:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  hostContext,
  type Context,
  type HostAgentsSeam,
  type HostCLISeam,
  type HostRPCSeam,
  type HostSeam,
} from "./host.ts";

// THE load-bearing §2/§7 check: the real host API assigns to the
// structural seam CAST-FREE against SDK 0.4.21 declarations. Kept inside
// a never-invoked function — there is no runtime BbPluginApi value.
function assertSeamAssignable(bb: BbPluginApi): HostSeam {
  return bb;
}
void assertSeamAssignable;

function assertContext(bb: BbPluginApi): Context {
  return hostContext(bb);
}
void assertContext;

function assertContextFields(ctx: Context): void {
  void ctx.bb.pluginId;
  void ctx.bb.sdk.threads;
  void ctx.bb.storage.kv.get;
}
void assertContextFields;

function assertAgentsSeamFields(bb: HostSeam): void {
  void bb.agents.registerTool;
  void bb.agents.configure;
  void bb.agents.contributeInstructions;
}
void assertAgentsSeamFields;

type Expect<T extends true> = T;
type _composition = Expect<
  [HostSeam] extends [HostRPCSeam & HostCLISeam & HostAgentsSeam]
    ? [HostRPCSeam & HostCLISeam & HostAgentsSeam] extends [HostSeam]
      ? true
      : false
    : false
>;

test("the seam file stays type-only (nothing to run)", () => {
  assert.equal(typeof assertSeamAssignable, "function");
});

test("hostContext freezes { bb } and keeps bb live", () => {
  const bb = { sdk: { tag: 1 }, storage: { tag: 2 } } as unknown as BbPluginApi;
  const ctx = hostContext(bb);
  assert.equal(ctx.bb, bb);
  assert.equal("sdk" in ctx, false);
  assert.equal("storage" in ctx, false);
  assert.equal(Object.isFrozen(ctx), true);
  assert.throws(() => {
    Object.assign(ctx, { extra: true });
  });
});
