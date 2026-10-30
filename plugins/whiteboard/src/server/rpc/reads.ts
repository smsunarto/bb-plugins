import type { z } from "zod";
import type {
  commitsInput,
  diffFilesInput,
  fileInput,
  historyInput,
  mapInput,
  progressInput,
  resourceInput,
  sessionVersionInput,
  stackInput,
} from "../../shared/contracts/rpc.ts";
import type { WhiteboardContext } from "../lib/context.ts";
import { runOperation } from "./operation.ts";

/**
 * Reads keyed by what they read: a stored version, a source generation or a
 * coverage revision. They are never invalidated; the app re-keys them when the
 * live session moves on.
 */

type Ctx = WhiteboardContext<"engine">;

/** The source selector an app read sends, in the operations' terms. */
const selector = (input: z.output<typeof diffFilesInput>) => ({
  reviewId: input.sessionId,
  version: input.version,
  generation: input.generation,
  commit: input.commit,
  repositoryId: input.repositoryId,
  head: input.head,
  base: input.base,
});

export function sessionVersion(ctx: Ctx, input: z.output<typeof sessionVersionInput>) {
  return runOperation(ctx, "sessionVersion", input.threadId, (api) =>
    api.sessionVersion({ reviewId: input.sessionId, version: input.version }),
  );
}

export function history(ctx: Ctx, input: z.output<typeof historyInput>) {
  return runOperation(ctx, "history", input.threadId, (api) =>
    api.history({ reviewId: input.sessionId }),
  );
}

export function stack(ctx: Ctx, input: z.output<typeof stackInput>) {
  return runOperation(ctx, "stack", input.threadId, (api) =>
    api.stack({ reviewId: input.sessionId, version: input.version }),
  );
}

export function commits(ctx: Ctx, input: z.output<typeof commitsInput>) {
  return runOperation(ctx, "commits", input.threadId, (api) =>
    api.commits({ reviewId: input.sessionId, version: input.version }),
  );
}

export function map(ctx: Ctx, input: z.output<typeof mapInput>) {
  return runOperation(ctx, "map", input.threadId, (api) =>
    api.map({
      reviewId: input.sessionId,
      resourceId: input.resourceId,
      version: input.version,
      generation: input.generation,
    }),
  );
}

export function resource(ctx: Ctx, input: z.output<typeof resourceInput>) {
  return runOperation(ctx, "resource", input.threadId, async (api) => {
    const { mimeType, data } = await api.resource({
      reviewId: input.sessionId,
      resourceId: input.resourceId,
    });
    return { contentType: mimeType, base64: Buffer.from(data).toString("base64") };
  });
}

export function progress(ctx: Ctx, input: z.output<typeof progressInput>) {
  return runOperation(ctx, "progress", input.threadId, (api, signal) =>
    api.progress(
      {
        reviewId: input.sessionId,
        version: input.version,
        mode: input.mode,
        generation: input.generation,
        // The panel draws partial coverage and re-reads on `coverageRevision`.
        wait: false,
      },
      { signal },
    ),
  );
}

export function diffFiles(ctx: Ctx, input: z.output<typeof diffFilesInput>) {
  return runOperation(ctx, "diffFiles", input.threadId, (api) => api.changedFiles(selector(input)));
}

export function file(ctx: Ctx, input: z.output<typeof fileInput>) {
  return runOperation(ctx, "file", input.threadId, (api) =>
    api.file({
      ...selector(input),
      side: input.side,
      file: input.path,
      projection: input.projection,
    }),
  );
}
