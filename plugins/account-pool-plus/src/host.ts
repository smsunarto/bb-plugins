import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { antigravityHostContract } from "./antigravity-host-contract.js";
import { AntigravityHostRuntime } from "./antigravity-host-runtime.js";

const runtime = new AntigravityHostRuntime();

export default experimental_defineHostEntry({
  contract: antigravityHostContract,
  handlers: {
    "antigravity.loginStart": (input) => runtime.loginStart(input),
    "antigravity.loginComplete": (input) => runtime.loginComplete(input),
    "antigravity.loginCancel": (input) => runtime.loginCancel(input),
    "antigravity.probeUsage": (input) => runtime.probeUsage(input),
    "antigravity.removeProfile": (input) => runtime.removeProfile(input),
  },
});
