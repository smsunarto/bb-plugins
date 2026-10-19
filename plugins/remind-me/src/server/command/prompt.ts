import { defineCommand } from "@bb-kit/core/command";
import { instructionFiles } from "@bb-kit/core/instructions";

const files = instructionFiles(import.meta.url);

export const prompt = defineCommand({
  summary: "Read the /remind-me workflow for saving deferred work",
  execute: () => ({ exitCode: 0, stdout: `${files.read("remind-me")}\n` }),
});
