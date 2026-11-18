import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { expect, test } from "vitest";
import plugin from "./server.ts";
import { MIGRATIONS, openStore } from "./store.ts";
import { captainHost, newCaptain } from "./test-host.ts";

test("migrations apply once, a second open changes nothing, and rows survive a reload", async () => {
  const host = await captainHost();
  const captainId = await newCaptain(host);
  host.server.store.putCrewRole({
    threadId: "thr_crew",
    captainId,
    role: "implement",
    reportDueSince: 1_500,
    contractSent: false,
    rung: 2,
    baseBranch: "crew/x",
  });

  openStore(host.bb);
  const reloaded = await host.harness.lifecycle.reload(plugin);
  const again = openStore(reloaded.bb);

  const db = reloaded.bb.storage.database();
  const applied = db.prepare("SELECT id FROM _bb_migrations ORDER BY id").all() as { id: number }[];
  expect(applied.map((row) => row.id)).toEqual(MIGRATIONS.map((_, index) => index));
  expect(again.captain(captainId)).toMatchObject({
    name: "Plugins",
    archivedAt: null,
    repos: [{ bbProjectId: "proj_plugins", tasksProjectKey: "BBPLUGINS" }],
  });
  expect(again.crewRole("thr_crew")).toEqual({
    threadId: "thr_crew",
    captainId,
    role: "implement",
    reportDueSince: 1_500,
    contractSent: false,
    rung: 2,
    baseBranch: "crew/x",
  });

  // The reloaded plugin rebuilt its registry from data.db: the crew still gets its role.
  const resolved = await reloaded.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ thread: { id: "thr_crew", parentThreadId: captainId } }),
  );
  expect(resolved.instructions).toContain("# Role: Implement");
});
