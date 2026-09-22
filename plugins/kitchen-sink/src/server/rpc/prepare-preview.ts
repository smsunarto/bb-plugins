import { defineQuery } from "@bb-kit/core/rpc";
import { preparePreviewInputSchema, preparePreviewOutputSchema } from "../../shared/contract.ts";
import {
  httpStatus,
  MAX_PREVIEW_BYTES,
  previewKind,
  previewPathApi,
  requireAbsolutePreviewFile,
} from "../lib/preview-file.ts";

export const preparePreview = defineQuery({
  input: preparePreviewInputSchema,
  output: preparePreviewOutputSchema,
  async execute(ctx, input) {
    const file = requireAbsolutePreviewFile(input.file);
    const path = previewPathApi(file);
    const rootPath = path.dirname(file);
    const { hostId } = await ctx.bb.sdk.threads.storageLocation({ threadId: input.threadId });
    let result;
    try {
      result = await ctx.bb.sdk.files.read({ path: file, rootPath, hostId });
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
    const lease = await ctx.bb.sdk.files.createPreview({ hostId, rootPath, ttlMs: 3_600_000 });
    const metadata = {
      file,
      hostId,
      url: `${lease.baseUrl}/${encodeURIComponent(path.basename(file))}`,
      expiresAtMs: lease.expiresAtMs,
    };
    const kind = previewKind(file);
    return kind === "markdown"
      ? { kind, ...metadata, content: result.content }
      : { kind, ...metadata, html: result.content };
  },
});
