import { Eta } from "eta/core";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { parseCanvas, maxCanvasBytes } from "../../shared/parse.ts";
import { collectDiagnostics } from "../../shared/document.ts";

export const templateName = z.enum(["review", "issue", "pull-request"]);
const text = z.string().trim().min(1);
const heading = text.refine((value) => !/[\r\n]/.test(value), "Headings must be one line");
export const templateData = z
  .object({
    title: heading,
    summary: text,
    context: text.optional(),
    why: text.optional(),
    steps: z.array(text).optional(),
    expected: text.optional(),
    actual: text.optional(),
    sections: z
      .array(
        z
          .object({
            title: heading,
            body: text,
            collapsible: z.boolean().optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const eta = new Eta({ autoEscape: false, autoTrim: false });
const readTemplate = (name: z.infer<typeof templateName>) =>
  readFileSync(new URL(import.meta.resolve(`#canvas-templates/${name}.eta`)), "utf8");
const templates = {
  review: readTemplate("review"),
  issue: readTemplate("issue"),
  "pull-request": readTemplate("pull-request"),
};
const compiled = new Map<string, ReturnType<typeof eta.compile>>();

export function generateCanvas(name: z.infer<typeof templateName>, input: unknown): string {
  const data = templateData.parse(input);
  if (name !== "review" && (data.why !== undefined || data.sections.some((s) => s.collapsible))) {
    throw new Error("why and collapsible sections are supported only by the review template");
  }
  if (name !== "issue" && [data.steps, data.expected, data.actual].some((v) => v !== undefined)) {
    throw new Error("steps, expected and actual are supported only by the issue template");
  }
  let render = compiled.get(name);
  if (!render) {
    render = eta.compile(templates[name]);
    compiled.set(name, render);
  }
  const content = render.call(eta, data).trimEnd() + "\n";
  if (Buffer.byteLength(content, "utf8") > maxCanvasBytes)
    throw new Error("Generated Canvas exceeds 2 MiB");
  const parsed = parseCanvas(content);
  const diagnostics = parsed.ok ? collectDiagnostics(parsed.document) : [parsed.diagnostic];
  if (diagnostics.length)
    throw new Error(diagnostics.map((d) => `${d.span?.line ?? "?"}: ${d.message}`).join("\n"));
  return content;
}
