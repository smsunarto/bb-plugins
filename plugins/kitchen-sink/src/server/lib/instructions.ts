import { instructionFiles } from "@bb-plugins/instructions";

/** This plugin's agent text under `instructions/`, editable in the Prompt Editor. */
export const files = instructionFiles(import.meta.url);
