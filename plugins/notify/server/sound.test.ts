import assert from "node:assert/strict";
import { test } from "bun:test";
import { resolveSound, SOUND_NAMES, SOUND_OFF, SOUND_OPTIONS, SOUND_SYSTEM } from "./sound.ts";

test("the settings dropdown offers off, system, then the tones", () => {
  assert.equal(SOUND_OPTIONS[0], SOUND_OFF);
  assert.equal(SOUND_OPTIONS[1], SOUND_SYSTEM);
  assert.deepEqual([...SOUND_OPTIONS].slice(2), [...SOUND_NAMES]);
  assert.equal(new Set(SOUND_OPTIONS).size, SOUND_OPTIONS.length);
});

test("resolveSound maps silence, default, and named tones", () => {
  assert.equal(resolveSound(SOUND_OFF), null);
  assert.equal(resolveSound(SOUND_SYSTEM), "default");
  assert.equal(resolveSound("Ping"), "Ping");
});

test("resolveSound rejects values outside the allowlist", () => {
  assert.equal(resolveSound("Nonesuch"), null);
  assert.equal(resolveSound(""), null);
  assert.equal(resolveSound("ping"), null);
});

test("every listed tone resolves to itself", () => {
  for (const name of SOUND_NAMES) {
    assert.equal(resolveSound(name), name);
  }
});
