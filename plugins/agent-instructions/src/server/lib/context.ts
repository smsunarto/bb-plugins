import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type { Publisher } from "../../catalog/publish.ts";
import type { hostContract, hostSignals } from "../../host-contract.ts";
import type { SourceStore } from "../../source/store.ts";
import type { SyncManager } from "../../sync/manager.ts";

/** Shared server context handed to RPC handlers and CLI commands. */
export type AgentInstructionsContext = Readonly<{
  bb: BbPluginApi;
  store: SourceStore;
  host: ExperimentalHostClient<typeof hostContract, typeof hostSignals>;
  publisher: Publisher;
  sync: SyncManager;
}>;
