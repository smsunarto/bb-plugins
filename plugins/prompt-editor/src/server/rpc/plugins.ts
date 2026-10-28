import { z } from "zod";
import { pluginsSchema } from "../../shared/schema.ts";
import { describePlugin } from "../lib/agent-text.ts";
import type { PromptEditorContext } from "../lib/context.ts";
import { installedPlugins } from "../lib/installed.ts";

export const pluginsContract = {
  input: z.null(),
  output: pluginsSchema,
};

/** Every installed plugin that gives agents text, editable ones first. */
export async function plugins({
  bb,
}: PromptEditorContext): Promise<z.input<typeof pluginsContract.output>> {
  const described = (await installedPlugins(bb)).flatMap((plugin) => {
    const description = describePlugin(plugin);
    return description ? [description] : [];
  });
  described.sort(
    (a, b) =>
      Number(a.readOnly !== null) - Number(b.readOnly !== null) || a.name.localeCompare(b.name),
  );
  return { plugins: described };
}
