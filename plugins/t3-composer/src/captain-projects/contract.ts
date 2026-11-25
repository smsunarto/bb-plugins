import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const CAPTAIN_PLUGIN_ID = "captain";

/**
 * This plugin's copy of the one Captain method it reads, `homeProjects` in
 * plugins/captain/src/contract/rpc.ts, since plugins do not import each other. The tag is
 * Captain's `CAPTAINS_TAG`, which Captain invalidates whenever a Captain starts or is
 * archived, so the read refreshes then.
 */
export const captainProjectsContract = defineRpcContract({
  homeProjects: {
    input: z.object({}).strict(),
    output: z.object({ projectIds: z.array(z.string()) }),
    tags: () => ["captains"],
  },
});
