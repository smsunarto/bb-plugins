import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from "./standard-schema.ts";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const schema = z.object({ path: z.string() });

// zod 4 schemas satisfy the vendored interface directly, no adapter.
const asStandard: StandardSchemaV1<{ path: string }, { path: string }> = schema;
void asStandard;

type _input = Expect<Equal<SchemaInput<typeof schema>, { path: string }>>;
type _output = Expect<Equal<SchemaOutput<typeof schema>, { path: string }>>;

test("validate accepts a conforming value", async () => {
  const result = await schema["~standard"].validate({ path: "a.txt" });
  assert.ok(!result.issues);
  assert.deepEqual(result.value, { path: "a.txt" });
});

test("validate reports issues for a non-conforming value", async () => {
  const result = await schema["~standard"].validate(5);
  assert.ok(result.issues);
  assert.ok(result.issues.length > 0);
  assert.equal(typeof result.issues[0]?.message, "string");
});
