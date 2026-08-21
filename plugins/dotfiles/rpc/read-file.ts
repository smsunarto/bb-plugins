import { defineQuery } from "@bb-kit/core/rpc";
import type { Context } from "../server/context.ts";
import { readFileInputSchema, readFileOutputSchema } from "../server/contract.ts";
import { isAllowedPath } from "../server/model.ts";

export const readFile = defineQuery({
  input: readFileInputSchema,
  output: readFileOutputSchema,
  handler: async ({ repository }: Context, { path }) => {
    const repoPath = await repository.getRepoPath();
    // Allowlist guard, duplicated with save-file.ts on purpose: rpc/
    // holds only units, so shared micro-logic stays inline.
    const skills = repository.repoExists(repoPath) ? repository.discoverSkills(repoPath) : [];
    if (!isAllowedPath(path, skills)) {
      throw new Error(`not a tweakable file: ${path}`);
    }
    const [file, headContent] = await Promise.all([
      repository.readFile(repoPath, path),
      repository.readHeadFile(repoPath, path),
    ]);
    return { ...file, headContent };
  },
});
