import { z } from "zod";

export const updateAutorouterEnabledInputSchema = z.strictObject({ enabled: z.boolean() });
export const updateAutorouterEnabledOutputSchema = z.strictObject({ enabled: z.boolean() });

export type AutorouterRpcContract = {
  updateAutorouterEnabled: {
    input: typeof updateAutorouterEnabledInputSchema;
    output: typeof updateAutorouterEnabledOutputSchema;
  };
};
