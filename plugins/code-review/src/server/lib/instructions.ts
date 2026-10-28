import { instructionFiles } from "@bb-plugins/instructions";

// Agent-facing text, editable in the Prompt Editor plugin.
export const files = instructionFiles(import.meta.url);
