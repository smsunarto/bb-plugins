import { defineCommand, PluginCliError } from "@bb-kit/core/command";
import { absolutePath, hostOption, invokingHostId } from "../lib/cli-source.ts";
import { generateCanvas, templateName } from "../lib/generate.ts";
import { maxCanvasBytes } from "../../shared/parse.ts";

export const generate = defineCommand({
  summary: "Generate a validated Canvas from a bundled Eta template and JSON data",
  positionals: [
    { name: "template", description: "review, issue, or pull-request", required: true },
  ],
  options: {
    data: {
      type: "string",
      description: "JSON data file on the invoking host",
      placeholder: "file",
      required: true,
    },
    out: {
      type: "string",
      description: "New .canvas.mdx output file",
      placeholder: "file",
      required: true,
    },
    host: hostOption,
    json: { type: "boolean", description: "Print the generated path as JSON" },
  },
  async execute(ctx, { positionals, options: input }) {
    const template = templateName.safeParse(positionals.template);
    if (!template.success) {
      throw new PluginCliError(
        `invalid value '${positionals.template}' for <template>. Expected one of: ${templateName.options.join(", ")}`,
        { code: "invalid_value" },
      );
    }
    const out = absolutePath(ctx, input.out);
    if (!out.endsWith(".canvas.mdx")) throw new PluginCliError("Output must end in .canvas.mdx");
    const data = absolutePath(ctx, input.data);
    const hostId = await invokingHostId(ctx, input.host);
    try {
      const file = await ctx.bb.sdk.files.read({ hostId, path: data });
      if (file.contentEncoding !== "utf8") throw new Error("Data must be a UTF-8 JSON file");
      if (Buffer.byteLength(file.content, "utf8") > maxCanvasBytes)
        throw new Error("Data exceeds 2 MiB");
      const content = generateCanvas(template.data, JSON.parse(file.content));
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
          ? `${JSON.stringify({ path: out, hostId, template: template.data })}\n`
          : `ok — generated ${out}\n`,
      };
    } catch (error) {
      throw new PluginCliError(error instanceof Error ? error.message : String(error));
    }
  },
});
