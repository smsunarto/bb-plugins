import { z } from "zod";

export const updateAutorouterSettingsInputSchema = z.strictObject({
  values: z.record(z.string(), z.union([z.string(), z.boolean()])),
});
export const updateAutorouterSettingsOutputSchema = z.strictObject({ saved: z.literal(true) });
export type AutorouterSettingsRpcContract = {
  updateAutorouterSettings: {
    input: typeof updateAutorouterSettingsInputSchema;
    output: typeof updateAutorouterSettingsOutputSchema;
  };
};
