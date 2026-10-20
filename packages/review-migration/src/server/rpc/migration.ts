import { defineQuery, type Context } from "@bb-kit/core/rpc";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

type MigrationContext = Context<{
  db: ReturnType<BbPluginApi["storage"]["database"]>;
  models: () => Promise<{ claudeModel: string; codexModel: string }>;
}>;

// Read-only bridge: loading this version stops the old workflow before export.
export const migration = defineQuery({
  input: z.object({ section: z.enum(["runs", "kv"]), offset: z.number().int().min(0) }),
  output: z.object({
    rows: z.array(
      z.object({ id: z.string(), parent: z.string(), status: z.string(), payload: z.string() }),
    ),
    values: z.array(z.object({ key: z.string(), value: z.json() })),
    models: z.object({ claudeModel: z.string(), codexModel: z.string() }),
    nextOffset: z.number().nullable(),
  }),
  async execute({ bb, db, models }: MigrationContext, { section, offset }) {
    const rows =
      section === "runs" &&
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'review_runs'").get()
        ? db
            .prepare<[number], { id: string; parent: string; status: string; payload: string }>(
              "SELECT id, parent, status, payload FROM review_runs ORDER BY rowid LIMIT 10 OFFSET ?",
            )
            .all(offset)
        : [];
    const keys =
      section === "kv"
        ? (await bb.storage.kv.list())
            .filter((key) => key.startsWith("reviewer:") || key.startsWith("report:"))
            .sort()
            .slice(offset, offset + 10)
        : [];
    const values = await Promise.all(
      keys.map(async (key) => ({ key, value: z.json().parse(await bb.storage.kv.get(key)) })),
    );
    return {
      rows,
      values,
      models: await models(),
      nextOffset: (section === "runs" ? rows : values).length === 10 ? offset + 10 : null,
    };
  },
});
