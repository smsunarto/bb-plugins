import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

test("the migration bridge exports existing data without registering the old workflow", async () => {
  const f = createFakePluginHost({ pluginId: "review" });
  try {
    const db = f.bb.storage.database();
    db.exec("CREATE TABLE review_runs (id TEXT, parent TEXT, status TEXT, payload TEXT)");
    db.prepare("INSERT INTO review_runs VALUES (?, ?, ?, ?)").run(
      "run",
      "author",
      "completed",
      "{}",
    );
    await f.bb.storage.kv.set("report:run", { findings: [] });
    await f.bb.storage.kv.set("unrelated", "private");
    await plugin(f.bb);
    assert.equal(f.harness.inspection.registrations.agentTools.length, 0);
    const runs = await f.harness.behavior.callRpc("migration", { section: "runs", offset: 0 });
    assert.deepEqual((runs as { rows: unknown[] }).rows, [
      { id: "run", parent: "author", status: "completed", payload: "{}" },
    ]);
    const values = await f.harness.behavior.callRpc("migration", { section: "kv", offset: 0 });
    assert.deepEqual((values as { values: unknown[] }).values, [
      { key: "report:run", value: { findings: [] } },
    ]);
    assert.equal(
      db.prepare<[], { n: number }>("SELECT count(*) AS n FROM review_runs").get()?.n,
      1,
    );
  } finally {
    await f.harness.lifecycle.dispose();
  }
});
