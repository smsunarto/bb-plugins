import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { snapshotHostContract } from "../shared/host-contract.ts";
import { forget, pin, snapshot, turnPatch } from "./snapshots.ts";

export default experimental_defineHostEntry({
  contract: snapshotHostContract,
  handlers: {
    async snapshot({ environmentPath }, context) {
      return { commit: await snapshot(environmentPath, context.signal) };
    },
    async pin({ environmentPath, threadId, captures }, context) {
      await pin(environmentPath, threadId, captures, context.signal);
      return {};
    },
    async turnPatch({ environmentPath, threadId, window, recordedPaths, known }, context) {
      return {
        snapshot: await turnPatch(
          environmentPath,
          threadId,
          window,
          recordedPaths,
          known,
          context.signal,
        ),
      };
    },
    async forget({ environmentPath, threadId, at }, context) {
      await forget(environmentPath, threadId, at, context.signal);
      return {};
    },
  },
});
