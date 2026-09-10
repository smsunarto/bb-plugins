import { defineMutation } from "@bb-kit/core/rpc";
import {
  updateAutorouterSettingsInputSchema,
  updateAutorouterSettingsOutputSchema,
} from "../../shared/autorouter/settings-contract.ts";
import { updateAutorouterSettings as persistSettings } from "../lib/autorouter/settings.ts";

export const updateAutorouterSettings = defineMutation({
  input: updateAutorouterSettingsInputSchema,
  output: updateAutorouterSettingsOutputSchema,
  async execute({ bb }, { values }) {
    await persistSettings(bb, values);
    return { saved: true as const };
  },
});
