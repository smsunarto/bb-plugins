import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifySharedServiceDefinition,
  retireCurrentDevOwnedSharedServices,
  type SharedServiceRetirementCandidate,
} from "../lib/shared-service-retirement.ts";

const root = "/Users/scott/.bb-dev/worktree-5468d9357fa9/plugins/agent-proxy";

function candidate(name: "core" | "tunnel", calls: string[]): SharedServiceRetirementCandidate {
  const definitionPath = `/definitions/${name}`;
  const requiredPath = `${root}/${name}/runtime`;
  return {
    name,
    label: `com.bb.plugin.agent-proxy.${name}`,
    definitionPath,
    expectedDefinition: `command=${requiredPath}\nworking-directory=${root}/${name}`,
    requiredOwnedPaths: [requiredPath, `${root}/${name}`],
    async stop() {
      calls.push(`stop:${name}`);
    },
  };
}

test("proves ownership only from the complete expected definition", () => {
  const expected = `command=${root}/core/runtime\nworking-directory=${root}/core`;
  assert.equal(
    classifySharedServiceDefinition(expected, {
      expectedDefinition: expected,
      requiredOwnedPaths: [`${root}/core/runtime`, `${root}/core`],
    }),
    "owned",
  );
  assert.equal(
    classifySharedServiceDefinition(`command=${root}/core/foreign`, {
      expectedDefinition: expected,
      requiredOwnedPaths: [`${root}/core/runtime`, `${root}/core`],
    }),
    "ambiguous",
  );
  assert.equal(
    classifySharedServiceDefinition("command=/Users/scott/.bb/plugins/agent-proxy/core", {
      expectedDefinition: expected,
      requiredOwnedPaths: [`${root}/core/runtime`, `${root}/core`],
    }),
    "foreign",
  );
  assert.equal(
    classifySharedServiceDefinition(null, {
      expectedDefinition: expected,
      requiredOwnedPaths: [`${root}/core/runtime`, `${root}/core`],
    }),
    "missing",
  );
});

test("releases an owned shared tunnel before its owned shared core", async () => {
  const calls: string[] = [];
  const tunnel = candidate("tunnel", calls);
  const core = candidate("core", calls);
  const definitions = new Map([
    [tunnel.definitionPath, tunnel.expectedDefinition],
    [core.definitionPath, core.expectedDefinition],
  ]);

  const result = await retireCurrentDevOwnedSharedServices({
    tunnel,
    core,
    readDefinition: (path) => definitions.get(path) ?? null,
    removeDefinition: (path) => {
      calls.push(`remove:${path.endsWith("tunnel") ? "tunnel" : "core"}`);
      definitions.delete(path);
    },
  });

  assert.deepEqual(calls, ["stop:tunnel", "remove:tunnel", "stop:core", "remove:core"]);
  assert.deepEqual(result, { retiredTunnel: true, retiredCore: true });
});

test("leaves missing and foreign shared definitions untouched", async () => {
  const calls: string[] = [];
  const tunnel = candidate("tunnel", calls);
  const core = candidate("core", calls);
  const definitions = new Map([[core.definitionPath, "production definition"]]);

  const result = await retireCurrentDevOwnedSharedServices({
    tunnel,
    core,
    readDefinition: (path) => definitions.get(path) ?? null,
    removeDefinition: () => calls.push("remove"),
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, { retiredTunnel: false, retiredCore: false });
});

test("refuses ambiguous ownership before stopping either shared service", async () => {
  const calls: string[] = [];
  const tunnel = candidate("tunnel", calls);
  const core = candidate("core", calls);
  const definitions = new Map([
    [tunnel.definitionPath, tunnel.expectedDefinition],
    [core.definitionPath, `command=${root}/core/unexpected`],
  ]);

  await assert.rejects(
    retireCurrentDevOwnedSharedServices({
      tunnel,
      core,
      readDefinition: (path) => definitions.get(path) ?? null,
      removeDefinition: () => calls.push("remove"),
    }),
    /refusing to stop or remove/,
  );
  assert.deepEqual(calls, []);
});

test("rechecks unchanged ownership before deleting a stopped definition", async () => {
  const calls: string[] = [];
  const tunnel = candidate("tunnel", calls);
  const core = candidate("core", calls);
  const definitions = new Map([
    [tunnel.definitionPath, tunnel.expectedDefinition],
    [core.definitionPath, core.expectedDefinition],
  ]);
  tunnel.stop = async () => {
    calls.push("stop:tunnel");
    definitions.set(tunnel.definitionPath, "definition replaced during stop");
  };

  await assert.rejects(
    retireCurrentDevOwnedSharedServices({
      tunnel,
      core,
      readDefinition: (path) => definitions.get(path) ?? null,
      removeDefinition: () => calls.push("remove"),
    }),
    /changed while the shared service was stopping/,
  );
  assert.deepEqual(calls, ["stop:tunnel"]);
});
