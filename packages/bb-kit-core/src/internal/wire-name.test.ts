import { test } from "node:test";
import assert from "node:assert/strict";
import { kebabName, wireName } from "./wire-name.ts";

test("wire names: pinned derivations", () => {
  assert.equal(wireName("audit-log", "readEntry"), "audit_log_read_entry");
  assert.equal(wireName("audit-log", "readURL"), "audit_log_read_url");
  // Acronym-unaware on purpose: URLPath does NOT split.
  assert.equal(wireName("audit-log", "readURLPath"), "audit_log_read_urlpath");
  assert.equal(wireName("dotfiles", "overview"), "dotfiles_overview");
});

test("wire names: digit boundaries", () => {
  // lower/digit followed by upper gets an underscore.
  assert.equal(wireName("vault", "save2FA"), "vault_save2_fa");
});

test("kebab names for the rpc subtree", () => {
  assert.equal(kebabName("overview"), "overview");
  assert.equal(kebabName("readFile"), "read-file");
  assert.equal(kebabName("readURL"), "read-url");
  assert.equal(kebabName("readURLPath"), "read-urlpath");
});
