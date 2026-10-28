import type { z } from "zod";
import { readProjectScripts } from "../lib/project-scripts.ts";
import type { KitchenSinkContext } from "../lib/context.ts";
import {
  projectScriptsInputSchema,
  projectScriptsOutputSchema,
} from "../../shared/thread-details.ts";

export const projectScriptsContract = {
  experimental_description: "List the project scripts the thread details card runs.",
  input: projectScriptsInputSchema,
  output: projectScriptsOutputSchema,
};

/** A project's scripts, shared by every client, as the thread details card lists them. */
export async function projectScripts(
  { bb }: KitchenSinkContext,
  { projectId }: z.output<typeof projectScriptsContract.input>,
): Promise<z.input<typeof projectScriptsContract.output>> {
  return { scripts: await readProjectScripts(bb, projectId) };
}
