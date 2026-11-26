import { defineCli, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { catalogContracts } from "../catalog/contract.ts";
import { openPublisher } from "../catalog/publish.ts";
import { catalogHandlers } from "../catalog/rpc.ts";
import { documentContracts } from "../documents/model.ts";
import { documentHandlers } from "../documents/server.ts";
import { hostContract, hostSignals } from "../host-contract.ts";
import { promptContract, promptHandlers } from "../prompts/server/server.ts";
import { openSourceStore } from "../source/store.ts";
import { openSyncManager } from "../sync/manager.ts";
import { add } from "./command/add.ts";
import { catalogCommand } from "./command/catalog.ts";
import { editCommands } from "./command/edit.ts";
import { list } from "./command/list.ts";
import { migrateCommand } from "./command/migrate.ts";
import { pathCommand } from "./command/path.ts";
import { preview } from "./command/preview.ts";
import { publishCommand, publishFindings } from "./command/publish.ts";
import { remove } from "./command/remove.ts";
import { syncCommand } from "./command/sync.ts";
import type { AgentInstructionsContext } from "./lib/context.ts";
import { rules, rulesContract } from "./rpc/rules.ts";
import { saveRules, saveRulesContract } from "./rpc/save-rules.ts";
import { targets, targetsContract } from "./rpc/targets.ts";

export const contract = defineRpcContract({
  ...documentContracts,
  ...catalogContracts,
  plugins: promptContract.plugins,
  file: promptContract.file,
  save: promptContract.save,
  rules: rulesContract,
  saveRules: saveRulesContract,
  targets: targetsContract,
});

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const store = openSourceStore(bb);
  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });
  const publisher = openPublisher(bb, store);
  const sync = openSyncManager({ bb, store, host });
  const ctx: AgentInstructionsContext = Object.freeze({ bb, store, host, publisher, sync });

  const prompts = promptHandlers(bb);
  const catalogRpc = catalogHandlers(ctx);

  bb.rpc.register(contract, {
    ...documentHandlers(bb),
    ...catalogRpc,
    plugins: prompts.plugins,
    file: prompts.file,
    save: prompts.save,
    rules: () => rules(ctx),
    saveRules: (input) => saveRules(ctx, input),
    targets: () => targets(ctx),
  });

  bb.cli.register(
    defineCli({
      name: "agent-instructions",
      summary: "CLI for the agent-instructions plugin",
      commands: {
        path: pathCommand(ctx),
        sync: syncCommand(ctx),
        migrate: migrateCommand(ctx),
        list: list(ctx),
        add: add(ctx),
        remove: remove(ctx),
        preview: preview(ctx),
        catalog: catalogCommand(ctx),
        publish: publishCommand(ctx),
        ...editCommands(ctx, catalogRpc),
      },
    }),
  );

  function publishInBackground(): void {
    void publisher
      .run()
      .then((report) => publishFindings(report, store.rulesState().rules))
      .then(
        ({ problems, warnings }) =>
          [...problems, ...warnings].forEach((finding) => bb.log.warn(`publish: ${finding}`)),
        (error: unknown) =>
          bb.log.error(`publishing the catalog failed: ${(error as Error).message}`),
      );
  }

  let localSyncTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleLocalMirrorSync(): void {
    if (localSyncTimer) clearTimeout(localSyncTimer);
    localSyncTimer = setTimeout(() => {
      localSyncTimer = null;
      void sync.syncAllConnected();
    }, 1_500);
    localSyncTimer.unref?.();
  }

  const unsubChange = store.onChange((event) => {
    // Disk edits and remote sync pulls must republish immediately; local UI/CLI writes
    // already await publishCatalog/publishWithin, though rules/doc edits still notify clients.
    if (event.reason !== "local" && event.catalogChanged) {
      publishInBackground();
    }
    if (event.catalogChanged || event.rulesChanged) {
      bb.realtime.publish("sourceChanged", {
        revision: event.revision,
        rulesRevision: event.rulesRevision,
      });
    }
    if (event.catalogChanged || event.rulesChanged || event.manifestChanged) {
      if (event.reason === "local") {
        // Debounce rapid local autosaves (e.g. Rules typing every 500ms) before fanning out over the network.
        scheduleLocalMirrorSync();
      } else {
        void sync.syncAllConnected({ excludeHostId: event.originHostId });
      }
    }
  });

  bb.onDispose(() => {
    if (localSyncTimer) {
      clearTimeout(localSyncTimer);
      localSyncTimer = null;
    }
    unsubChange();
    store.dispose();
    sync.dispose();
  });

  await store.load();
  store.startWatch();
  // Converges whatever an earlier run left, unless a partial migration state was detected.
  if (store.migrationBlocked() === null) {
    publishInBackground();
  }

  // `configure`, unlike `contributeInstructions`, sees the host, provider,
  // and model a thread resolves with, which is what rules match on.
  bb.agents.configure((session) => {
    const instructions = store.resolve(session.thread.id, session);
    return { tools: [], skills: [], ...(instructions === null ? {} : { instructions }) };
  });
}
