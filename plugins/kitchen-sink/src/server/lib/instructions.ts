import { instructionFiles } from "@bb-kit/core/instructions";

/** This plugin's agent text under `instructions/`, editable in the Prompt Editor. */
export const files = instructionFiles(import.meta.url);
