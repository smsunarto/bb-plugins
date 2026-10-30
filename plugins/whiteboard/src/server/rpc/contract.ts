import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CATALOG_TAG,
  LIVE_SESSION_TAG,
  commitsInput,
  copyContextInput,
  diffFilesInput,
  fileInput,
  historyInput,
  liveSessionInput,
  mapInput,
  markProgressInput,
  progressInput,
  resourceInput,
  sessionTag,
  sessionVersionInput,
  sessionsInput,
  stackInput,
} from "../../shared/contracts/rpc.ts";
import type { WhiteboardContext } from "../lib/context.ts";
import { claimOpen, claimOpenContract } from "./claim-open.ts";
import { info, infoContract } from "./info.ts";
import { liveFile, liveFileContract } from "./live-file.ts";
import {
  commits,
  diffFiles,
  file,
  history,
  map,
  progress,
  resource,
  sessionVersion,
  stack,
} from "./reads.ts";
import { liveSession, sessions, watchLiveReads } from "./sessions.ts";
import { command, commandInput, copyContext, markProgress } from "./writes.ts";

/** What a handler answers: the server is trusted, so outputs are typed, not validated. */
type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;
const answer = <F extends (...args: never[]) => Promise<unknown>>() => z.custom<Answer<F>>();

/** The panel's RPC methods. `sessions` and `liveSession` are live reads. */
export const contract = defineRpcContract({
  info: infoContract,
  claimOpen: claimOpenContract,
  liveFile: liveFileContract,
  sessions: {
    input: sessionsInput,
    output: answer<typeof sessions>(),
    tags: () => [CATALOG_TAG],
  },
  liveSession: {
    input: liveSessionInput,
    output: answer<typeof liveSession>(),
    tags: (_input, output) => [sessionTag(output.reviewId), LIVE_SESSION_TAG],
  },
  sessionVersion: { input: sessionVersionInput, output: answer<typeof sessionVersion>() },
  history: { input: historyInput, output: answer<typeof history>() },
  stack: { input: stackInput, output: answer<typeof stack>() },
  commits: { input: commitsInput, output: answer<typeof commits>() },
  map: { input: mapInput, output: answer<typeof map>() },
  resource: { input: resourceInput, output: answer<typeof resource>() },
  progress: { input: progressInput, output: answer<typeof progress>() },
  markProgress: { input: markProgressInput, output: answer<typeof markProgress>() },
  copyContext: { input: copyContextInput, output: answer<typeof copyContext>() },
  diffFiles: { input: diffFilesInput, output: answer<typeof diffFiles>() },
  file: { input: fileInput, output: answer<typeof file>() },
  command: { input: commandInput, output: answer<typeof command>() },
});

/** Register every method's handler and the live reads' producers. */
export function registerRpc(ctx: WhiteboardContext<"engine">): void {
  ctx.bb.rpc.register(contract, {
    info: (input) => info(ctx, input),
    claimOpen: (input) => claimOpen(ctx, input),
    liveFile: (input) => liveFile(ctx, input),
    sessions: (input) => sessions(ctx, input),
    liveSession: (input) => liveSession(ctx, input),
    sessionVersion: (input) => sessionVersion(ctx, input),
    history: (input) => history(ctx, input),
    stack: (input) => stack(ctx, input),
    commits: (input) => commits(ctx, input),
    map: (input) => map(ctx, input),
    resource: (input) => resource(ctx, input),
    progress: (input) => progress(ctx, input),
    markProgress: (input) => markProgress(ctx, input),
    copyContext: (input) => copyContext(ctx, input),
    diffFiles: (input) => diffFiles(ctx, input),
    file: (input) => file(ctx, input),
    command: (input) => command(ctx, input),
  });
  watchLiveReads(ctx.bb, ctx.engine);
}
