import { defineQuery } from "@bb-kit/core/rpc";

import {
  preparePreviewInputSchema,
  preparePreviewOutputSchema,
  type PreparePreviewOutput,
} from "../../shared/contract.ts";
import {
  httpStatus,
  MAX_PREVIEW_BYTES,
  previewKind,
  requireRelativePreviewFile,
  resolveContainedPreviewPath,
} from "../lib/preview-file.ts";

type PreviewDocument = Extract<PreparePreviewOutput, { kind: "markdown" }>["document"];

export const preparePreview = defineQuery({
  input: preparePreviewInputSchema,
  output: preparePreviewOutputSchema,
  async execute(ctx, input) {
    const { threadId, source } = input;
    const file = requireRelativePreviewFile(input.file);
    let rootPath: string;
    let hostId: string;
    let target: PreviewDocument["target"];

    if (source === "thread-storage") {
      const storage = await ctx.bb.sdk.threads.storageLocation({ threadId });
      rootPath = storage.storageRootPath;
      hostId = storage.hostId;
      target = { kind: source, threadId, path: file };
    } else {
      const thread = await ctx.bb.sdk.threads.get({ threadId, include: "environment" });
      if (!("environment" in thread)) {
        throw new Error(
          "Thread environment was not returned. inline-vis needs a live environment.",
        );
      }
      const environment = thread.environment;
      const workspacePath = typeof environment?.path === "string" ? environment.path : null;
      if (!environment || !workspacePath) {
        throw new Error("This thread has no workspace path. inline-vis needs a live environment.");
      }
      const workspaceHostId = typeof environment.hostId === "string" ? environment.hostId : null;
      if (!workspaceHostId) {
        throw new Error("This thread's environment has no hostId. Cannot read workspace files.");
      }
      rootPath = workspacePath;
      hostId = workspaceHostId;
      target = { kind: source, environmentId: environment.id, path: file };
    }

    const absolutePath = resolveContainedPreviewPath(rootPath, file);

    let result;
    try {
      result = await ctx.bb.sdk.files.read({ path: absolutePath, rootPath, hostId });
    } catch (error) {
      if (httpStatus(error) === 404)
        throw new Error(`Preview file not found: ${file}`, { cause: error });
      throw error;
    }

    if (result.contentEncoding !== "utf8") {
      throw new Error(`Preview file is not valid UTF-8 text (encoding=${result.contentEncoding}).`);
    }
    if (result.sizeBytes > MAX_PREVIEW_BYTES) {
      throw new Error(
        `Preview file is too large (${result.sizeBytes} bytes; max ${MAX_PREVIEW_BYTES}).`,
      );
    }

    const kind = previewKind(file);
    return kind === "markdown"
      ? { kind, file, source, content: result.content, document: { rootPath, threadId, target } }
      : { kind, file, source, html: result.content };
  },
});
