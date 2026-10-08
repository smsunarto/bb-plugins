import { defineQuery } from "@bb-kit/core/rpc";
import { pluginsSchema } from "../../shared/schema.ts";
import { describePlugin } from "../lib/agent-text.ts";
import { installedPlugins } from "../lib/installed.ts";

/** Every installed plugin that gives agents text, editable ones first. */
export const plugins = defineQuery({
  output: pluginsSchema,
  async execute({ bb }) {
    const described = (await installedPlugins(bb)).flatMap((plugin) => {
      const description = describePlugin(plugin);
      return description ? [description] : [];
    });
    described.sort(
      (a, b) =>
        Number(a.readOnly !== null) - Number(b.readOnly !== null) || a.name.localeCompare(b.name),
    );
    return { plugins: described };
  },
});
