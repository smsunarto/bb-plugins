import { ensureUnityStorage } from "./unity-storage-migration.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { editorSchema } from "../../shared/unity-editor-contract.ts";

const snapshotSchema = z.object({ version: z.literal(1), claims: z.array(z.string()) }).strict();
const renamedSnapshotSchema = snapshotSchema.extend({ migratedKitchenSink: z.boolean() });
const claimSchema = z
  .object({
    instance: editorSchema,
    hostId: z.string(),
    ownerThreadId: z.string(),
    claimId: z.string(),
    mode: z.enum(["runtime", "authoring"]),
    jobId: z.string().nullable(),
    claimedAt: z.string(),
    operationLoadId: z.string().optional(),
    orphaned: z.boolean().optional(),
  })
  .strict();
type Db = ReturnType<BbPluginApi["storage"]["database"]>;
const migration = "kitchen-sink-v1";

/** Import and receipt commit together. A failed handoff never opens an empty claim pool. */
export function legacyClaimsGuard(bb: BbPluginApi, db: Db): () => Promise<void> {
  db.exec("CREATE TABLE IF NOT EXISTS unity_editor_migrations (id TEXT PRIMARY KEY)");
  const completed = () =>
    Boolean(db.prepare("SELECT id FROM unity_editor_migrations WHERE id = ?").get(migration));
  let pending: Promise<void> | undefined;
  const importClaims = db.transaction((records: string[]) => {
    if (completed()) return;
    const claims = records.map((record) => claimSchema.parse(JSON.parse(record)));
    for (const claim of claims) {
      // Verification is read-only. An interrupted submission may still be running in Unity.
      if (claim.jobId === "verifying") continue;
      if (claim.jobId === "submitting") claim.jobId = "uncertain";
      db.prepare(
        "INSERT INTO unity_editor_claims (key, host, workspace, record) VALUES (?, ?, ?, ?)",
      ).run(
        `${claim.hostId}:${claim.instance.id}`,
        claim.hostId,
        claim.instance.workspacePath,
        JSON.stringify(claim),
      );
    }
    db.prepare("INSERT INTO unity_editor_migrations (id) VALUES (?)").run(migration);
  });
  const migrate = async () => {
    const { plugins } = await bb.sdk.plugins.list();
    const renamed = plugins.find((plugin) => plugin.id === "unity-editors");
    let records: string[] = [];
    let migratedKitchenSink = false;
    if (renamed) {
      if (!renamed.enabled || renamed.status !== "running") {
        throw new Error("Finish the unity-editors namespace handoff before using Unity.");
      }
      const snapshot = await bb.sdk.plugins.callRpc({
        pluginId: "unity-editors",
        method: "exportUnityClaims",
        input: {},
        outputSchema: renamedSnapshotSchema,
      });
      records = snapshot.claims;
      migratedKitchenSink = snapshot.migratedKitchenSink;
    }
    const legacy = plugins.find((plugin) => plugin.id === "kitchen-sink");
    if (legacy && !migratedKitchenSink) {
      if (!legacy.enabled || legacy.status !== "running") {
        throw new Error(
          "Enable and reload the updated kitchen-sink plugin to transfer existing Unity claims.",
        );
      }
      const snapshot = await bb.sdk.plugins.callRpc({
        pluginId: "kitchen-sink",
        method: "exportUnityClaims",
        input: {},
        outputSchema: snapshotSchema,
      });
      records.push(...snapshot.claims);
    }
    importClaims.immediate(records);
  };
  return async () => {
    await ensureUnityStorage(bb, db);
    if (completed()) return;
    pending ??= migrate().catch((error: unknown) => {
      pending = undefined;
      throw new Error(
        "Unity claim migration is incomplete. Finish the legacy plugin handoff and retry.",
        { cause: error },
      );
    });
    await pending;
  };
}
