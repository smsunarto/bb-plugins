import { defineMutation } from "@bb-kit/core/rpc";
import { editProjectScripts } from "../lib/project-scripts.ts";
import {
  projectScriptsOutputSchema,
  saveProjectScriptInputSchema,
} from "../../shared/thread-details.ts";

/** Add, replace, or delete one project script, leaving the others as stored. */
export const saveProjectScript = defineMutation({
  input: saveProjectScriptInputSchema,
  output: projectScriptsOutputSchema,
  description: "Add, replace, or delete one project script the thread details card runs.",
  async execute({ bb }, { projectId, edit }) {
    return { scripts: await editProjectScripts(bb, projectId, edit) };
  },
});
