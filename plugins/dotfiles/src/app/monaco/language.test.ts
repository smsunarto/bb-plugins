import { test } from "bun:test";
import assert from "node:assert/strict";
import { languageForPath } from "./language.ts";

test("maps dotfile and extension paths to Monaco languages", () => {
  assert.equal(languageForPath(".gitconfig"), "ini");
  assert.equal(languageForPath("nested/.GITCONFIG"), "ini");
  assert.equal(languageForPath("mise.toml"), "ini");
  assert.equal(languageForPath("rules/AGENTS.md"), "markdown");
  assert.equal(languageForPath("script.ZSH"), "shell");
});

test("uses plaintext when a path has no known extension", () => {
  assert.equal(languageForPath("Dockerfile"), "plaintext");
  assert.equal(languageForPath("config.unknown"), "plaintext");
  assert.equal(languageForPath("empty."), "plaintext");
});
