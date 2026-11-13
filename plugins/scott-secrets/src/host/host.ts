import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "../shared/host-contract.ts";
import { createSudoHandlers } from "./handlers.ts";
import { createSudoRunner } from "./sudo.ts";

const sudo = createSudoHandlers(createSudoRunner());

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    sudoForget: ({ threadId }) => sudo.forget(threadId),
    sudoRun: (input, context) =>
      sudo.run(input, {
        signal: context.signal,
        retain: () => context.experimental_retainWorker(),
      }),
  },
  dispose: () => {
    sudo.cache.clearAll();
  },
});
