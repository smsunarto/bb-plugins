import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { projectIndexSchema } from "../../shared/autorouter/policy.ts";
import { saveProjectIndex } from "../lib/autorouter/settings.ts";

export const saveAutorouterProjectIndex = defineMutation({
  input: z.strictObject({ entries: projectIndexSchema }),
  output: z.strictObject({ count: z.number().int().nonnegative() }),
  async execute({ bb }, { entries }) {
    await saveProjectIndex(bb, entries);
    return { count: entries.length };
  },
});
