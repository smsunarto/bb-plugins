import { expect, onTestFinished, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../src/server/server.ts";
import { storageMigrations } from "../src/server/lib/storage-migrations.ts";

test("existing snapshot migration history and saved evidence survive plugin startup", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  // Disposing removes the fake host's storage dir.
  onTestFinished(() => harness.lifecycle.dispose());
  const db = bb.storage.database();
  bb.storage.migrate(db, storageMigrations);
  db.prepare("INSERT INTO smart_diff_snapshots_v2 (key, payload) VALUES (?, ?)").run(
    "saved",
    "evidence",
  );
  await plugin(bb);
  expect(
    db.prepare("SELECT payload FROM smart_diff_snapshots_v2 WHERE key = ?").get("saved"),
  ).toEqual({ payload: "evidence" });
  expect(harness.registrations.rpcMethods).not.toContain("renderEmbed");
  db.close();
});
