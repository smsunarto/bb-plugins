import assert from "node:assert/strict";
import { test } from "node:test";
import { systemdUserUnitPath } from "../lib/paths.ts";
import { canStopService } from "../lib/service-actions.ts";
import {
  planRuntimeReconciliation,
  runtimeConfigFingerprint,
} from "../lib/runtime-state.ts";

test("runtime fingerprints cover startup-only port and management key settings", () => {
  const original = runtimeConfigFingerprint({ port: 8317, managementKey: "one" });
  assert.equal(original, runtimeConfigFingerprint({ port: 8317, managementKey: "one" }));
  assert.notEqual(original, runtimeConfigFingerprint({ port: 8318, managementKey: "one" }));
  assert.notEqual(original, runtimeConfigFingerprint({ port: 8317, managementKey: "two" }));
});

test("a loaded service restarts before an unapplied runtime config is written", () => {
  assert.deepEqual(
    planRuntimeReconciliation({
      appliedFingerprint: "old",
      desiredFingerprint: "new",
      desiredRunning: true,
      serviceLoaded: true,
    }),
    { stopBeforeWrite: true, writeConfig: true, startAfterWrite: true },
  );
  assert.deepEqual(
    planRuntimeReconciliation({
      appliedFingerprint: "old",
      desiredFingerprint: "new",
      desiredRunning: false,
      serviceLoaded: true,
    }),
    { stopBeforeWrite: true, writeConfig: true, startAfterWrite: false },
  );
});

test("a matching loaded service is adopted without rewriting its live config", () => {
  assert.deepEqual(
    planRuntimeReconciliation({
      appliedFingerprint: "same",
      desiredFingerprint: "same",
      desiredRunning: true,
      serviceLoaded: true,
    }),
    { stopBeforeWrite: false, writeConfig: false, startAfterWrite: false },
  );
});

test("systemd unit paths follow an absolute XDG_CONFIG_HOME", () => {
  assert.equal(
    systemdUserUnitPath("/home/test", "agent-proxy", "/home/test/custom-config"),
    "/home/test/custom-config/systemd/user/agent-proxy.service",
  );
  assert.equal(
    systemdUserUnitPath("/home/test", "agent-proxy", ""),
    "/home/test/.config/systemd/user/agent-proxy.service",
  );
  assert.throws(
    () => systemdUserUnitPath("/home/test", "agent-proxy", "relative/config"),
    /must be an absolute path/,
  );
});

test("Stop remains available for a stopped but loaded service", () => {
  assert.equal(canStopService("stopped", true), true);
  assert.equal(canStopService("stopped", false), false);
  assert.equal(canStopService("not-installed", false), false);
  assert.equal(canStopService("running", true), true);
});
