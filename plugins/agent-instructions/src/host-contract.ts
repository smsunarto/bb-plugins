import { defineRpcContract } from "@get-bb/plugin-sdk";
import { documentHostMethods } from "./documents/model.ts";
import { syncHostMethods, syncHostSignals } from "./sync/host-contract.ts";

/** The plugin's one `bb.host` entry serves both the documents and mirror-sync methods. */
export const hostContract = defineRpcContract({ ...documentHostMethods, ...syncHostMethods });
export const hostSignals = syncHostSignals;
