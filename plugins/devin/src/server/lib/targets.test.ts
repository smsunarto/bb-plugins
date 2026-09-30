import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CLOUD_INTENT_TTL_MS, createTargetStore, TARGET_MIGRATIONS } from "./targets.ts";

function store() {
  const { bb } = createFakePluginHost({ pluginId: "devin" });
  const db = bb.storage.database();
  bb.storage.migrate(db, TARGET_MIGRATIONS);
  const clock = { now: 1_000_000 };
  return { clock, targets: createTargetStore(db, () => clock.now) };
}

test("a thread runs locally unless Cloud was armed", () => {
  const { targets } = store();
  assert.equal(targets.claim("thr_a"), "local");
  assert.equal(targets.target("thr_a"), "local");
});

test("the armed Cloud toggle goes to exactly one new thread", () => {
  const { targets } = store();
  targets.setCloudArmed(true);
  assert.equal(targets.cloudArmed(), true);
  assert.equal(targets.claim("thr_cloud"), "cloud");
  assert.equal(targets.cloudArmed(), false);
  assert.equal(targets.claim("thr_next"), "local");
});

test("a thread keeps its first target for good", () => {
  const { targets } = store();
  assert.equal(targets.claim("thr_local"), "local");
  targets.setCloudArmed(true);
  assert.equal(targets.claim("thr_local"), "local");
  assert.equal(targets.cloudArmed(), true);
});

test("an armed toggle expires after ten minutes", () => {
  const { clock, targets } = store();
  targets.setCloudArmed(true);
  clock.now += CLOUD_INTENT_TTL_MS;
  assert.equal(targets.claim("thr_late"), "local");
});

test("disarming and forgetting clear the stored state", () => {
  const { targets } = store();
  targets.setCloudArmed(true);
  targets.setCloudArmed(false);
  assert.equal(targets.cloudArmed(), false);
  targets.claim("thr_gone");
  targets.forget("thr_gone");
  assert.equal(targets.target("thr_gone"), null);
});
