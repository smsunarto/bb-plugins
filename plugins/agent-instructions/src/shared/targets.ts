import { z } from "zod";

const targetSchema = z.object({ id: z.string(), name: z.string() });

/** Everything a rule can be scoped to that bb knows about right now. */
export const targetsSchema = z.object({
  hosts: z.array(targetSchema),
  providers: z.array(targetSchema),
  projects: z.array(targetSchema),
});

export type Target = z.infer<typeof targetSchema>;
export type Targets = z.infer<typeof targetsSchema>;
