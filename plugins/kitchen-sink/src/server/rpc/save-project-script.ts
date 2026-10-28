import type { z } from "zod";
import { editProjectScripts } from "../lib/project-scripts.ts";
import type { KitchenSinkContext } from "../lib/context.ts";
import {
  projectScriptsOutputSchema,
  saveProjectScriptInputSchema,
} from "../../shared/thread-details.ts";

export const saveProjectScriptContract = {
  experimental_description:
    "Add, replace, or delete one project script the thread details card runs.",
  input: saveProjectScriptInputSchema,
  output: projectScriptsOutputSchema,
};

/** Add, replace, or delete one project script, leaving the others as stored. */
export async function saveProjectScript(
  { bb }: KitchenSinkContext,
  { projectId, edit }: z.output<typeof saveProjectScriptContract.input>,
): Promise<z.input<typeof saveProjectScriptContract.output>> {
  return { scripts: await editProjectScripts(bb, projectId, edit) };
}
