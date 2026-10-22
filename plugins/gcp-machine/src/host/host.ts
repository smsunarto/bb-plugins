import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "../shared/host-contract.ts";
import { GoogleCompute } from "../shared/node/cloud.ts";

const cloud = new GoogleCompute();
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    inspect: ({ target, access }, ctx) => cloud.inspect(target, access, ctx.signal),
    power: ({ target, access, action, requestId }, ctx) =>
      cloud.power(target, access, action, requestId, ctx.signal),
    bootstrap: ({ target, access, command, stdin, timeoutMs }, ctx) =>
      cloud.bootstrap(target, access, command, stdin, timeoutMs, ctx.signal),
  },
});
