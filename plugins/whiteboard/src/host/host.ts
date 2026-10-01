import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  whiteboardHostContract,
  whiteboardHostSignals,
} from "../shared/contracts/host-contract.ts";
import { readBlobs } from "./lib/blobs.ts";
import { invoke, probe } from "./lib/invoke.ts";
import { cancelStructuralDiff, runStructuralDiff } from "./lib/structural-stream.ts";
import { vcsCall } from "./lib/vcs-handles.ts";
import { unwatchWorktree, watchWorktree } from "./lib/watch.ts";

export default experimental_defineHostEntry({
  contract: whiteboardHostContract,
  experimental_signals: whiteboardHostSignals,
  handlers: {
    invoke: (input, ctx) => invoke(input, ctx.signal),
    vcsCall: (input, ctx) => vcsCall(input, ctx.signal),
    readBlobs: (input, ctx) => readBlobs(input, ctx.signal),
    structuralDiff: (input, ctx) =>
      runStructuralDiff(
        input,
        (payload) => ctx.experimental_emitSignal("structuralEvents", payload),
        ctx.signal,
      ),
    cancelStructuralDiff: (input) => cancelStructuralDiff(input),
    watchWorktree: (input, ctx) => watchWorktree(input, ctx),
    unwatchWorktree: (input) => unwatchWorktree(input),
    probe: () => probe(),
  },
});
