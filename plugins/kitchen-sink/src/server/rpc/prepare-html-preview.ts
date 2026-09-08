import { defineQuery } from "@bb-kit/core/rpc";

import {
  prepareHtmlPreviewInputSchema,
  prepareHtmlPreviewOutputSchema,
} from "../../shared/contract.ts";
import {
  httpStatus,
  MAX_HTML_BYTES,
  requireWorkspaceHtmlFile,
  resolveContainedHtmlPath,
} from "../lib/html-preview.ts";

export const prepareHtmlPreview = defineQuery({
  input: prepareHtmlPreviewInputSchema,
  output: prepareHtmlPreviewOutputSchema,
  async execute(ctx, input) {
    const file = requireWorkspaceHtmlFile(input.file);
    const thread = await ctx.bb.sdk.threads.get({
      threadId: input.threadId,
      include: "environment",
    });

    if (!("environment" in thread)) {
      throw new Error("Thread environment was not returned. inline-vis needs a live environment.");
    }

    const environment = thread.environment;
    const rootPath = typeof environment?.path === "string" ? environment.path : null;
    if (!rootPath) {
      throw new Error("This thread has no workspace path. inline-vis needs a live environment.");
    }
    const hostId = typeof environment?.hostId === "string" ? environment.hostId : null;
    if (!hostId) {
      throw new Error("This thread's environment has no hostId. Cannot read workspace files.");
    }

    const absolutePath = resolveContainedHtmlPath(rootPath, file);

    let result;
    try {
      result = await ctx.bb.sdk.files.read({ path: absolutePath, rootPath, hostId });
    } catch (error) {
      if (httpStatus(error) === 404)
        throw new Error(`HTML file not found: ${file}`, { cause: error });
      throw error;
    }

    if (result.contentEncoding !== "utf8") {
      throw new Error(`HTML file is not valid UTF-8 text (encoding=${result.contentEncoding}).`);
    }
    if (result.sizeBytes > MAX_HTML_BYTES) {
      throw new Error(`HTML file is too large (${result.sizeBytes} bytes; max ${MAX_HTML_BYTES}).`);
    }

    return { file };
  },
});
