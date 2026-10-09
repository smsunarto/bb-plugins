// The `bb.host` artifact runs on every host daemon. Its provider bridge runs
// Amp threads there, and the default host entry answers the plugin server
// about that same machine: the Oracle reports the bridge wrote and the Amp CLI
// it would spawn.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostCliPath } from "./src/bridge/entry.ts";
import { ampHostContract } from "./src/host-contract.ts";
import { loadOracleReport } from "./src/oracle-report-store.ts";

export { experimental_providerBridge } from "./src/bridge/entry.ts";

export default experimental_defineHostEntry({
  contract: ampHostContract,
  handlers: {
    oracleReport: ({ reportId }) => ({ report: loadOracleReport(reportId) }),
    cliStatus: () => ({ path: hostCliPath(undefined) }),
  },
});
