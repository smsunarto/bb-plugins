import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The manager moved to unity. Its old database remains readable for the handoff. */
export function registerLegacyUnityClaims(bb: BbPluginApi) {
  bb.rpc.register(
    defineRpcContract({
      exportUnityClaims: {
        input: z.object({}).strict(),
        output: z.object({ version: z.literal(1), claims: z.array(z.string()) }).strict(),
      },
    }),
    {
      exportUnityClaims() {
        const db = bb.storage.database();
        const exists = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("kitchen_sink_unity_editor_claims");
        const rows = exists
          ? (db.prepare("SELECT record FROM kitchen_sink_unity_editor_claims").all() as {
              record: string;
            }[])
          : [];
        return { version: 1 as const, claims: rows.map((row) => row.record) };
      },
    },
  );
}
