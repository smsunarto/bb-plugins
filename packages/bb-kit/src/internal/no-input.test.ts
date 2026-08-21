import { test } from "node:test";
import assert from "node:assert/strict";
import { noInputSchema } from "./no-input.ts";

test("accepts null (SDK hooks and fake host deliver null)", async () => {
  const result = await noInputSchema["~standard"].validate(null);
  assert.ok(!result.issues);
  assert.equal(result.value, null);
});

test("accepts undefined (empty POST body)", async () => {
  const result = await noInputSchema["~standard"].validate(undefined);
  assert.ok(!result.issues);
  assert.equal(result.value, undefined);
});

test("rejects everything else", async () => {
  for (const value of [{}, "", 0, false, []]) {
    const result = await noInputSchema["~standard"].validate(value);
    assert.ok(result.issues, `expected issues for ${JSON.stringify(value)}`);
    assert.equal(result.issues[0]?.message, "this procedure takes no input");
  }
});

test("vendor is bb-kit", () => {
  assert.equal(noInputSchema["~standard"].vendor, "bb-kit");
});
