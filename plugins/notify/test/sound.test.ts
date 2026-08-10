import assert from "node:assert/strict";
import { test } from "node:test";
import {
  playSound,
  resolveSound,
  SOUND_NAMES,
  SOUND_OFF,
  SOUND_OPTIONS,
  SOUND_SYSTEM,
} from "../sound.ts";

test("the settings dropdown offers off, system, then the tones", () => {
  assert.equal(SOUND_OPTIONS[0], SOUND_OFF);
  assert.equal(SOUND_OPTIONS[1], SOUND_SYSTEM);
  assert.deepEqual([...SOUND_OPTIONS].slice(2), [...SOUND_NAMES]);
  assert.equal(new Set(SOUND_OPTIONS).size, SOUND_OPTIONS.length);
});

test("resolveSound maps the three kinds of choice", () => {
  assert.deepEqual(resolveSound(SOUND_OFF), { silent: true, play: null });
  assert.deepEqual(resolveSound(SOUND_SYSTEM), { silent: false, play: null });
  // A named tone silences the notification so macOS does not stack its own
  // default underneath the chosen one.
  assert.deepEqual(resolveSound("Ping"), { silent: true, play: "Ping" });
});

test("resolveSound falls back to silent for a value that is not on the list", () => {
  assert.deepEqual(resolveSound("Nonesuch"), { silent: true, play: null });
  assert.deepEqual(resolveSound(""), { silent: true, play: null });
  // Case matters: the name is matched, never normalised into a path.
  assert.deepEqual(resolveSound("ping"), { silent: true, play: null });
});

test("every listed tone resolves to itself", () => {
  for (const name of SOUND_NAMES) {
    assert.deepEqual(resolveSound(name), { silent: true, play: name });
  }
});

test("playSound ignores a name that is not on the list", async () => {
  // The guard is what keeps a settings string out of the filesystem, so these
  // must return without touching disk rather than throwing.
  await playSound("Ping; rm -rf /");
  await playSound("../../../bin/sh");
  await playSound("");
});
