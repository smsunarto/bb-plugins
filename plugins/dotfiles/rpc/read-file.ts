import { z } from "zod";
import { defineQuery } from "@bb-kit/core/rpc";
import type { Context } from "../server/context.ts";
import { isAllowedPath } from "../server/domain.ts";

const readFileInputSchema = z.object({ path: z.string() }).strict();
const readFileOutputSchema = z
  .object({
    content: z.string(),
    sha256: z.string(),
    headContent: z.string().nullable(),
  })
  .strict();

export type ReadFileResult = z.infer<typeof readFileOutputSchema>;

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
