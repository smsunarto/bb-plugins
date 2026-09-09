import { defineMutation } from "@bb-kit/core/rpc";
import {
  updateAutorouterEnabledInputSchema,
  updateAutorouterEnabledOutputSchema,
} from "../../shared/autorouter/contract.ts";
import { setAutorouterEnabled } from "../lib/autorouter/settings.ts";

export const updateAutorouterEnabled = defineMutation({
  input: updateAutorouterEnabledInputSchema,
  output: updateAutorouterEnabledOutputSchema,
  async execute({ bb }, { enabled }) {
    await setAutorouterEnabled(bb, enabled);
    return { enabled };
  },
});
