import { defineQuery } from "@bb-kit/core/rpc";
import { readProjectScripts } from "../lib/project-scripts.ts";
import {
  projectScriptsInputSchema,
  projectScriptsOutputSchema,
} from "../../shared/thread-details.ts";

/** A project's scripts, shared by every client, as the thread details card lists them. */
export const projectScripts = defineQuery({
  input: projectScriptsInputSchema,
  output: projectScriptsOutputSchema,
  description: "List the project scripts the thread details card runs.",
  async execute({ bb }, { projectId }) {
    return { scripts: await readProjectScripts(bb, projectId) };
  },
});
