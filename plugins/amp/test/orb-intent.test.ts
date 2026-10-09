import assert from "node:assert/strict";
import { test } from "bun:test";
import { createOrbIntent, ORB_INTENT_TTL_MS } from "../src/orb-intent.ts";

const PRESSED_AT = 1_000_000;

/** `createdAt` maps thread ids to when bb created them. A thread missing
 *  from it was created after the press; `null` makes the lookup fail. */
function intent(createdAt: Record<string, number | null> = {}) {
  const clock = { now: PRESSED_AT };
  const lookups: string[] = [];
  const orb = createOrbIntent(
    async (threadId) => {
      lookups.push(threadId);
      const at = createdAt[threadId];
      if (at === null) throw new Error(`thread ${threadId} not found`);
      return at ?? clock.now;
    },
    () => clock.now,
  );
  return { clock, lookups, orb };
}

/** Lets the creation-time lookups a command started settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("nothing runs on Orb until the toggle is armed", () => {
  const { orb } = intent();
  assert.equal(orb.armed(), false);
  orb.claim("thr_new");
  assert.equal(orb.runsOnOrb("thr_new"), false);
});

test("a thread announced before its first command takes the press, and later threads run local", async () => {
  const { lookups, orb } = intent();
  orb.setArmed(true);
  orb.claim("thr_orb");
  assert.equal(orb.armed(), false);
  assert.equal(orb.runsOnOrb("thr_orb"), true);
  orb.claim("thr_next");
  assert.equal(orb.runsOnOrb("thr_next"), false);
  await settle();
  assert.equal(orb.runsOnOrb("thr_orb"), true);
  // bb announced it as created, so its age is never looked up.
  assert.deepEqual(lookups, []);
});

test("two threads whose first commands come before their announcements: only the first runs on Orb", async () => {
  // bb may build a new thread's thread/start before thread.created lands.
  const { lookups, orb } = intent();
  orb.setArmed(true);
  assert.equal(orb.runsOnOrb("thr_first"), true);
  assert.equal(orb.armed(), false);
  assert.equal(orb.runsOnOrb("thr_second"), false);
  orb.claim("thr_first");
  orb.claim("thr_second");
  await settle();
  assert.deepEqual(
    ["thr_first", "thr_second"].map((threadId) => orb.runsOnOrb(threadId)),
    [true, false],
  );
  assert.equal(orb.armed(), false);
  assert.deepEqual(lookups, ["thr_first"]);
});

test("an older thread the server has not seen hands the press back to the new one", async () => {
  // After a restart the server has not seen this thread; it predates the press.
  const { orb } = intent({ thr_old: PRESSED_AT - 60_000 });
  orb.setArmed(true);
  assert.equal(orb.runsOnOrb("thr_old"), true);
  await settle();
  assert.equal(orb.armed(), true);
  assert.equal(orb.runsOnOrb("thr_old"), false);
  orb.claim("thr_new");
  assert.equal(orb.runsOnOrb("thr_new"), true);
  assert.equal(orb.armed(), false);
});

test("a thread whose age cannot be looked up keeps the press", async () => {
  // Handing it back could send a second thread to Orb.
  const { orb } = intent({ thr_unknown: null });
  orb.setArmed(true);
  assert.equal(orb.runsOnOrb("thr_unknown"), true);
  await settle();
  assert.equal(orb.armed(), false);
  assert.equal(orb.runsOnOrb("thr_unknown"), true);
  assert.equal(orb.runsOnOrb("thr_new"), false);
});

test("a hand-back does not re-arm a toggle the user turned off meanwhile", async () => {
  const { orb } = intent({ thr_old: PRESSED_AT - 60_000 });
  orb.setArmed(true);
  assert.equal(orb.runsOnOrb("thr_old"), true);
  orb.setArmed(false);
  await settle();
  assert.equal(orb.armed(), false);
  assert.equal(orb.runsOnOrb("thr_old"), false);
});

test("an armed toggle expires after ten minutes", () => {
  const { clock, orb } = intent();
  orb.setArmed(true);
  clock.now += ORB_INTENT_TTL_MS - 1;
  assert.equal(orb.armed(), true);
  clock.now += 1;
  assert.equal(orb.armed(), false);
  orb.claim("thr_late");
  assert.equal(orb.runsOnOrb("thr_late"), false);
});

test("disarming and forgetting clear the state", () => {
  const { orb } = intent();
  orb.setArmed(true);
  orb.setArmed(false);
  assert.equal(orb.armed(), false);
  orb.setArmed(true);
  orb.claim("thr_gone");
  orb.forget("thr_gone");
  assert.equal(orb.runsOnOrb("thr_gone"), false);
});
