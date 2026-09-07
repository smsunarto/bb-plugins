import { test } from "bun:test";
import assert from "node:assert/strict";
import { encodeSubPath, parseSubPath } from "./route.ts";

test("subPath round-trips repo paths", () => {
  const paths = [
    "mise.toml",
    ".dotfiles/.config/fish/config.fish",
    ".dotfiles/notes/scratch pad #1 100%.md",
  ];
  for (const path of paths) {
    assert.equal(parseSubPath(encodeSubPath(path)).path, path);
  }
});

test("the empty subPath means no selection", () => {
  assert.deepEqual(parseSubPath(""), { path: null });
});

test("a malformed percent sequence falls back to the raw segment", () => {
  assert.deepEqual(parseSubPath("%E0%A4%A"), { path: "%E0%A4%A" });
  assert.deepEqual(parseSubPath("docs/%E0%A4%A/file"), { path: "docs/%E0%A4%A/file" });
});
