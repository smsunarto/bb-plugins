import { argv, CommandError, defineCommand } from "@bb-kit/core/command";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { generateCanvas, templateName } from "../lib/generate.ts";
import { maxCanvasBytes } from "../../shared/parse.ts";

export const generate = defineCommand({
  summary: "Generate a validated Canvas from a bundled Eta template and JSON data",
  input: z.object({
    template: argv.argument(templateName, { description: "review, issue, or pull-request" }),
    data: argv.option(z.string().min(1).optional(), {
      description: "JSON data file on the invoking host",
    }),
    out: argv.option(z.string().min(1).optional(), { description: "New .canvas.mdx output file" }),
    host: argv.option(z.string().min(1).optional(), {
      description: "Host ID; required outside a thread",
    }),
    json: argv.flag(z.boolean().optional(), { description: "Print the generated path as JSON" }),
  }),
  async execute(ctx, input) {
    if (!input.data || !input.out) throw new CommandError("Both --data and --out are required");
    const absolute = (path: string) => {
      if (isAbsolute(path)) return path;
      if (!ctx.cwd)
        throw new CommandError("Use absolute paths when no working directory is available");
      return resolve(ctx.cwd, path);
    };
    const out = absolute(input.out);
    if (!out.endsWith(".canvas.mdx")) throw new CommandError("Output must end in .canvas.mdx");
    let hostId = input.host;
    if (!hostId && ctx.threadId) {
      hostId = (await ctx.bb.sdk.threads.storageLocation({ threadId: ctx.threadId })).hostId;
    }
    if (!hostId) throw new CommandError("Pass --host <host-id> when running outside a thread");
    try {
      const file = await ctx.bb.sdk.files.read({ hostId, path: absolute(input.data) });
      if (file.contentEncoding !== "utf8") throw new Error("Data must be a UTF-8 JSON file");
      if (Buffer.byteLength(file.content, "utf8") > maxCanvasBytes)
        throw new Error("Data exceeds 2 MiB");
      const content = generateCanvas(input.template, JSON.parse(file.content));
      const saved = await ctx.bb.sdk.files.write({
        hostId,
        path: out,
        content,
        contentEncoding: "utf8",
        createParents: true,
        expectedSha256: null,
      });
      if (saved.outcome !== "written")
        throw new Error(`${out} already exists; choose a new output path`);
      return {
        exitCode: 0,
        stdout: input.json
          ? `${JSON.stringify({ path: out, hostId, template: input.template })}\n`
          : `ok — generated ${out}\n`,
      };
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error));
    }
  },
});
