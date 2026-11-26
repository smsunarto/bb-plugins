import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { documentHostHandlers } from "./documents/host.ts";
import { hostContract, hostSignals } from "./host-contract.ts";
import { disposeSyncHost, syncHostHandlers } from "./sync/host.ts";

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: { ...documentHostHandlers, ...syncHostHandlers },
  dispose: disposeSyncHost,
});
