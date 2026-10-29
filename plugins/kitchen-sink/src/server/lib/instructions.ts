import { instructionFiles } from "@bb-plugins/instructions";

/** This plugin's agent text under `instructions/`, editable in Agent Instructions → Plugin prompts. */
export const files = instructionFiles(import.meta.url);
