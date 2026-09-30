import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudProjectInstructions } from "./cloud-context.ts";

test("names the repository bb has open, and says nothing without a remote", () => {
  assert.equal(
    cloudProjectInstructions("https://github.com/smsunarto/bb-plugins"),
    "Repository: https://github.com/smsunarto/bb-plugins. Work there; clone it first if it is not on this machine.",
  );
  assert.equal(cloudProjectInstructions(null), undefined);
});

test("flattens whitespace so the block stays one line", () => {
  assert.equal(
    cloudProjectInstructions(" https://example.com/x.git\n"),
    "Repository: https://example.com/x.git. Work there; clone it first if it is not on this machine.",
  );
});
