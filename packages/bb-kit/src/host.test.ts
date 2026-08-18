import { test } from "node:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HostSeam, HostCLISeam, HostRPCSeam } from "./host.ts";

// THE load-bearing §2/§6 check: the real host API assigns to the
// structural seam CAST-FREE against SDK 0.4.6 declarations. Kept inside
// a never-invoked function — there is no runtime BbPluginApi value.
function assertSeamAssignable(bb: BbPluginApi): HostSeam {
  return bb;
}
void assertSeamAssignable;

type Expect<T extends true> = T;
type _composition = Expect<
  [HostSeam] extends [HostRPCSeam & HostCLISeam]
    ? [HostRPCSeam & HostCLISeam] extends [HostSeam]
      ? true
      : false
    : false
>;

test("the seam file stays type-only (nothing to run)", () => {
  assert.equal(typeof assertSeamAssignable, "function");
});
