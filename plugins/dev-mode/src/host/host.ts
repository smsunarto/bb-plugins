import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "../shared/host-contract.ts";
import review from "./review.ts";
import { ArenaGit } from "./git.ts";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    ...review.handlers,
    snapshot: (input, ctx) =>
      new ArenaGit(ctx.experimental_paths.dataDir).snapshot(input, ctx.signal),
    prepare: (input, ctx) =>
      new ArenaGit(ctx.experimental_paths.dataDir).prepare(input, ctx.signal),
    receipt: (input, ctx) =>
      new ArenaGit(ctx.experimental_paths.dataDir).receipt(input, ctx.signal),
    integrate: (input, ctx) =>
      new ArenaGit(ctx.experimental_paths.dataDir).integrate(input, ctx.signal),
  },
});
