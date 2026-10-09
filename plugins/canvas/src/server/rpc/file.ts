import { defineQuery } from "@bb-kit/core/rpc";
import { fileInputSchema, fileOutputSchema, type FileOutput } from "../../shared/file.ts";
import { readCanvasFile } from "../read.ts";

export const file = defineQuery({
  input: fileInputSchema,
  output: fileOutputSchema,
  async execute(ctx, { source, knownSha256 }): Promise<FileOutput> {
    const read = await readCanvasFile(ctx.bb, source, knownSha256);
    if (read.status !== "read") return read;
    const { sha256, content } = read.file;
    return { status: "read", sha256, content };
  },
});
