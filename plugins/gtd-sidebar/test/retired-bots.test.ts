import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { RETIRED_BOT_MIGRATIONS, registerRetiredBotsExport } from "../lib/retired-bots.ts";

type Handler = (input: object, ctx: { experimental_caller: unknown }) => unknown;

function exportHandler() {
  const db = new Database(":memory:");
  for (const statement of RETIRED_BOT_MIGRATIONS) db.run(statement);
  db.prepare("INSERT INTO bots(id,data) VALUES (?,?)").run("bot_a", "{}");
  db.prepare("INSERT INTO bot_threads(thread_id,bot_id) VALUES (?,?)").run("thr_1", "bot_a");
  let handler: Handler | undefined;
  const bb = {
    storage: { database: () => db },
    rpc: {
      register: (_contract: unknown, handlers: { retired_bots_export: Handler }) => {
        handler = handlers.retired_bots_export;
      },
    },
  } as unknown as BbPluginApi;
  registerRetiredBotsExport(bb);
  return handler!;
}

describe("retired bots export", () => {
  it("hands the Bots plugin every retired table", async () => {
    const result = (await exportHandler()(
      {},
      { experimental_caller: { kind: "plugin", pluginId: "bots" } },
    )) as { tables: Record<string, unknown[]> };
    expect(result.tables.bots).toEqual([{ id: "bot_a", data: "{}" }]);
    expect(result.tables.bot_threads).toEqual([{ thread_id: "thr_1", bot_id: "bot_a" }]);
    expect(Object.keys(result.tables)).toHaveLength(7);
  });

  it("refuses every other caller", () => {
    const handler = exportHandler();
    expect(() => handler({}, { experimental_caller: { kind: "client" } })).toThrow("Bots plugin");
    expect(() =>
      handler({}, { experimental_caller: { kind: "plugin", pluginId: "slopcop" } }),
    ).toThrow("Bots plugin");
  });
});
