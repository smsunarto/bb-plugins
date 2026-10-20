import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { database } from "./database.ts";
import { parseRun } from "./review-service.ts";

const pageSchema = z.object({
  rows: z.array(
    z.object({ id: z.string(), parent: z.string(), status: z.string(), payload: z.string() }),
  ),
  values: z.array(z.object({ key: z.string(), value: z.json() })),
  models: z.object({ claudeModel: z.string(), codexModel: z.string() }),
  nextOffset: z.number().nullable(),
});
const migrated = "review:migrated-from-review";

async function copyThreadMetadata(bb: BbPluginApi, run: ReturnType<typeof parseRun>) {
  const ids = new Set(run.seats.flatMap((seat) => [seat.threadId, seat.fallback?.from.threadId]));
  for (const threadId of ids) {
    if (!threadId) continue;
    try {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: "review" });
      if (metadata.reviewRun)
        await bb.sdk.threads.updatePluginMetadata({
          threadId,
          set: { reviewRun: metadata.reviewRun },
        });
    } catch (error) {
      if (!(error instanceof Error && /thread.*not found|404/i.test(error.message))) throw error;
    }
  }
}

async function importPage(
  bb: BbPluginApi,
  db: ReturnType<typeof database>,
  page: z.infer<typeof pageSchema>,
) {
  for (const row of page.rows) {
    const run = parseRun(row.payload);
    db.prepare(
      "INSERT OR IGNORE INTO review_runs (id, parent, status, payload) VALUES (?, ?, ?, ?)",
    ).run(row.id, row.parent, row.status, JSON.stringify(run));
    await copyThreadMetadata(bb, run);
  }
  for (const { key, value } of page.values) {
    if ((await bb.storage.kv.get(key)) == null) await bb.storage.kv.set(key, value);
  }
}

/** A single retryable handoff; reviews cannot dispatch until the legacy owner has retired. */
export function reviewMigration(
  bb: BbPluginApi,
  setModels: (models: z.infer<typeof pageSchema>["models"]) => Promise<unknown>,
) {
  let pending: Promise<void> | undefined;
  async function migrate() {
    const legacy = (await bb.sdk.plugins.list()).plugins.find((plugin) => plugin.id === "review");
    if (!legacy) return;
    if (await bb.storage.kv.get(migrated)) {
      if (legacy.enabled) await bb.sdk.plugins.disable({ pluginId: "review" });
      return;
    }
    if (!legacy.enabled)
      throw new Error(
        "Install and enable the Review migration bridge to import saved reviews, then retry.",
      );
    const db = database(bb);
    for (const section of ["runs", "kv"] as const) {
      let offset: number | null = 0;
      while (offset !== null) {
        const page: z.infer<typeof pageSchema> = await bb.sdk.plugins
          .callRpc<z.infer<typeof pageSchema>>({
            pluginId: "review",
            method: "migration",
            input: { section, offset },
            outputSchema: pageSchema as never,
          })
          .catch((error) => {
            throw new Error(
              "Install or update the Review migration bridge, then reload it before using Scott Engineering reviews.",
              { cause: error },
            );
          });
        if (section === "runs" && offset === 0) await setModels(page.models);
        await importPage(bb, db, page);
        offset = page.nextOffset;
      }
    }
    // Mark before disabling: if interrupted between these steps, the next load can finish retirement.
    await bb.storage.kv.set(migrated, true);
    await bb.sdk.plugins.disable({ pluginId: "review" });
  }
  return () => {
    if (!pending)
      pending = migrate().catch((error) => {
        pending = undefined;
        throw error;
      });
    return pending;
  };
}
