import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { projectIndexSchema } from "../../shared/autorouter/policy.ts";
import { readAutorouterSettings } from "../lib/autorouter/settings.ts";

export const getAutorouterProjectIndex = defineQuery({
  output: z.strictObject({ entries: projectIndexSchema }),
  async execute({ bb }) {
    return { entries: (await readAutorouterSettings(bb)).projects };
  },
});
