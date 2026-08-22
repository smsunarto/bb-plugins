import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { runtimeProcedures } from "./procedure.ts";
import type { AnyProcedure } from "./procedure.ts";
import type { UnionToIntersection } from "../internal/types.ts";
import { defineQuery, defineRPC } from "./rpc.ts";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type _u2i = Expect<Equal<UnionToIntersection<{ a: 1 } | { b: 2 }>, { a: 1 } & { b: 2 }>>;

const overview = defineQuery({
  output: z.object({ ok: z.boolean() }),
  handler: () => ({ ok: true }),
});

// A concrete procedure satisfies the loose AnyProcedure shape
// (method-syntax bivariance) without a cast.
const asAny: AnyProcedure = overview;
void asAny;

test("runtimeProcedures is a view over the same procedure objects", () => {
  const rpc = defineRPC({ namespace: "demo", procedures: { overview } });
  const runtime = runtimeProcedures(rpc);
  assert.deepEqual(Object.keys(runtime), ["overview"]);
  assert.equal(runtime.overview, overview as unknown);
});
