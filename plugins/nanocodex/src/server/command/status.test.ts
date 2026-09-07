import assert from "node:assert/strict";
import { test } from "bun:test";
import { status } from "./status.ts";

test("status is a bb-kit command that reports binding and auth state", async () => {
  assert.equal(status.summary, "Show NanoCodex binding and authentication status");
  const result = await status.execute({} as never);
  assert.match(result.stdout ?? "", /^binding: 0\.0\.0-preview-fa3f254\nauth seed: /);
  assert.doesNotMatch(result.stdout ?? "", /access[_-]?token|refresh[_-]?token/i);
});
