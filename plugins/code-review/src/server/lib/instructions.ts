import { instructionFiles } from "@bb-plugins/instructions";

// Agent-facing text, editable in Agent Instructions → Plugin prompts.
export const files = instructionFiles(import.meta.url);
