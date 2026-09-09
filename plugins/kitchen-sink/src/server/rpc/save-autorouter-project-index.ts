import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { projectIndexSchema } from "../../shared/autorouter/policy.ts";
import { saveProjectIndex } from "../lib/autorouter/settings.ts";

export const saveAutorouterProjectIndex = defineMutation({
  input: z.strictObject({ entries: projectIndexSchema }),
  output: z.strictObject({ count: z.number().int().nonnegative() }),
  async execute({ bb }, { entries }) {
    const known = new Set((await bb.sdk.projects.list()).map((project) => project.id));
    for (const entry of entries) {
      if (entry.projectId !== null && !known.has(entry.projectId)) {
        throw new Error(
          `Unknown BB project for ${entry.repository}. Use a known project ID or null.`,
        );
      }
    }
    await saveProjectIndex(bb, entries);
    return { count: entries.length };
  },
});
