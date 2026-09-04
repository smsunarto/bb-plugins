import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  resolveSound,
  resolveSoundPath,
  SOUND_CURSOR,
  SOUND_NAMES,
  SOUND_OFF,
  SOUND_OPTIONS,
  SOUND_SYSTEM,
} from "./sound.ts";

test("the settings dropdown offers off, system, Cursor, then the macOS tones", () => {
  assert.equal(SOUND_OPTIONS[0], SOUND_OFF);
  assert.equal(SOUND_OPTIONS[1], SOUND_SYSTEM);
  assert.equal(SOUND_OPTIONS[2], SOUND_CURSOR);
  assert.deepEqual([...SOUND_OPTIONS].slice(3), [...SOUND_NAMES]);
  assert.equal(new Set(SOUND_OPTIONS).size, SOUND_OPTIONS.length);
});

test("resolveSound maps silence, default, and named tones", () => {
  assert.deepEqual(resolveSound(SOUND_OFF), { silent: true, play: null });
  assert.deepEqual(resolveSound(SOUND_SYSTEM), { silent: false, play: null });
  assert.deepEqual(resolveSound(SOUND_CURSOR), { silent: true, play: SOUND_CURSOR });
  assert.deepEqual(resolveSound("Ping"), { silent: true, play: "Ping" });
});

test("resolveSound rejects values outside the allowlist", () => {
  assert.deepEqual(resolveSound("Nonesuch"), { silent: true, play: null });
  assert.deepEqual(resolveSound(""), { silent: true, play: null });
  assert.deepEqual(resolveSound("ping"), { silent: true, play: null });
});

test("sound paths use Cursor's installed completion sound or a macOS tone", () => {
  assert.equal(
    resolveSoundPath(SOUND_CURSOR),
    "/Applications/Cursor.app/Contents/Resources/app/out/vs/platform/accessibilitySignal/browser/media/done1.mp3",
  );
  assert.equal(resolveSoundPath("Ping"), "/System/Library/Sounds/Ping.aiff");
  assert.equal(resolveSoundPath("Nonesuch"), null);
});

test("every listed tone resolves to itself", () => {
  for (const name of SOUND_NAMES) {
    assert.deepEqual(resolveSound(name), { silent: true, play: name });
  }
});
