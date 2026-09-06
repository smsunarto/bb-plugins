import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeRawPage } from "./raw-text.ts";

test("raw preserves original JSON whitespace, escapes, and repeated keys", () => {
  const original =
    '  { "message": "héllo 🌍", "escaped": "a\\nb", "duplicate": 1, "duplicate": 2 }\r';
  assert.equal(decodeRawPage(Buffer.from(original).toString("base64"), 0, true), original);
});

test("overlapping raw pages never split valid UTF-8 characters", () => {
  const original = Buffer.from("aé€🌍z");
  for (let boundary = 1; boundary < original.length; boundary++) {
    const first = decodeRawPage(original.subarray(0, boundary + 3).toString("base64"), 0, false);
    const offset = Math.max(0, boundary - 3);
    const second = decodeRawPage(original.subarray(offset).toString("base64"), offset, true);
    assert.ok(!first.includes("�"), `first chunk at ${boundary}`);
    assert.ok(!second.includes("�"), `second chunk at ${boundary}`);
    for (const character of "aé€🌍z") assert.ok((first + second).includes(character));
  }
});
