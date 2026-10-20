import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import bridge from "../../../../../packages/review-migration/src/server/server.ts";
import { reviewMigration } from "./review-migration.ts";
import { database } from "./database.ts";
import { parseRun } from "./review-service.ts";
import { requestSchema } from "../../shared/review.ts";

const request = {
  ...requestSchema.parse({ kind: "design", summary: "Preserve this review" }),
  scope: "segment",
};
const original = {
  id: "old-run",
  contractVersion: 4,
  parentThreadId: "author",
  projectId: "project",
  environmentId: "env",
  hostId: "host",
  environmentPath: "/repo",
  request,
  target: null,
  evidence: [],
  startedAt: 10,
  status: "running",
  seats: [
    {
      reviewer: {
        providerId: "codex",
        model: "saved-model",
        reasoningLevel: "high",
        serviceTier: "fast",
      },
      threadId: "reviewer",
      afterSeq: 0,
    },
  ],
  fingerprint: createHash("sha256")
    .update(
      JSON.stringify({ request: { ...request, reuse: undefined }, target: null, evidence: [] }),
    )
    .digest("hex"),
};

test("legacy transfer preserves Arena, reports, settings, metadata and survives interruption", async () => {
  const old = createFakePluginHost({ pluginId: "review" });
  let enabled = true;
  let interrupt = true;
  let retireFailure = true;
  const metadata = { reviewRun: { id: "old-run", status: "running" } };
  const updated: unknown[] = [];
  const current = createFakePluginHost({
    pluginId: "scott-engineering",
    sdk: {
      plugins: {
        list: async () => ({ plugins: [{ id: "review", enabled }] }) as never,
        callRpc: async ({ method, input }) => {
          if (interrupt && (input as { section?: string })?.section === "kv") {
            interrupt = false;
            throw new Error("interrupted");
          }
          return (await old.harness.behavior.callRpc(method, input)) as never;
        },
        disable: async () => {
          if (retireFailure) {
            retireFailure = false;
            throw new Error("retire interrupted");
          }
          enabled = false;
          return {} as never;
        },
      },
      threads: {
        getPluginMetadata: async ({ pluginId }) => {
          assert.equal(pluginId, "review");
          return metadata;
        },
        updatePluginMetadata: async ({ set }) => {
          updated.push(set);
          return {} as never;
        },
      },
    },
  });
  try {
    await bridge(old.bb);
    const source = old.bb.storage.database();
    source.exec("CREATE TABLE review_runs (id TEXT, parent TEXT, status TEXT, payload TEXT)");
    source
      .prepare("INSERT INTO review_runs VALUES (?, ?, ?, ?)")
      .run(original.id, "author", original.status, JSON.stringify(original));
    await old.bb.storage.kv.set("reviewer:reviewer", original.id);
    await old.bb.storage.kv.set("report:old-run:0", { report: { findings: [] } });
    const db = database(current.bb);
    db.prepare("INSERT INTO arena_runs VALUES (?, ?, ?, ?, ?)").run(
      "arena",
      "author",
      "request",
      "completed",
      "{}",
    );
    const settings: unknown[] = [];
    const migrate = reviewMigration(current.bb, async (models) => {
      settings.push(models);
    });
    await assert.rejects(migrate(), /Install or update the Review migration bridge/);
    assert.equal(enabled, true);
    assert.equal(
      db.prepare<[], { n: number }>("SELECT count(*) AS n FROM review_runs").get()?.n,
      1,
    );
    await assert.rejects(migrate(), /retire interrupted/);
    await migrate();
    await migrate();
    assert.equal(enabled, false);
    assert.equal(
      db.prepare<[], { n: number }>("SELECT count(*) AS n FROM review_runs").get()?.n,
      1,
    );
    assert.equal(db.prepare<[], { n: number }>("SELECT count(*) AS n FROM arena_runs").get()?.n, 1);
    assert.equal(
      source.prepare<[], { n: number }>("SELECT count(*) AS n FROM review_runs").get()?.n,
      1,
    );
    assert.deepEqual(await current.bb.storage.kv.get("report:old-run:0"), {
      report: { findings: [] },
    });
    assert.equal(await current.bb.storage.kv.get("reviewer:reviewer"), "old-run");
    assert.deepEqual(updated[0], metadata);
    assert.deepEqual(settings[0], {
      claudeModel: "claude-opus-5-5[1m]",
      codexModel: "gpt-6-astra",
    });
    const run = parseRun(
      db.prepare<[], { payload: string }>("SELECT payload FROM review_runs").get()!.payload,
    );
    assert.notEqual(run.fingerprint, original.fingerprint);
    assert.equal(run.request.mode, "standard");
    assert.ok(!("scope" in run.request));
    assert.equal(
      run.fingerprint,
      parseRun(
        JSON.stringify({
          ...original,
          request: requestSchema.parse({ kind: "design", summary: "Preserve this review" }),
        }),
      ).fingerprint,
    );
  } finally {
    await old.harness.lifecycle.dispose();
    await current.harness.lifecycle.dispose();
  }
});
