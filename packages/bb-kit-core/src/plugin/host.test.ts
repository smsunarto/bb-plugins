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

function assertContextFields(context: Context): void {
  void context.bb.pluginId;
  void context.bb.sdk.threads;
  void context.bb.storage.kv.get;
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
  const context = hostContext(bb);
  assert.equal(context.bb, bb);
  assert.equal("sdk" in context, false);
  assert.equal("storage" in context, false);
  assert.equal(Object.isFrozen(context), true);
  assert.throws(() => {
    Object.assign(context, { extra: true });
  });
});
