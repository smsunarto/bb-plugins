import { defineQuery } from "@bb-kit/core/rpc";
import { fileInputSchema, fileOutputSchema, type FileOutput } from "../../shared/file.ts";
import { readCanvasFile } from "../read.ts";

export const file = defineQuery({
  input: fileInputSchema,
  output: fileOutputSchema,
  async execute(ctx, { source, knownSha256 }): Promise<FileOutput> {
    const read = await readCanvasFile(ctx.bb, source);
    if (!read.ok) return { status: "unreadable", reason: read.reason, detail: read.detail };
    const { sha256, content } = read.file;
    return knownSha256 === sha256
      ? { status: "unchanged", sha256 }
      : { status: "read", sha256, content };
  },
});
