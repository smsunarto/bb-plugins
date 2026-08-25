import { z } from "zod";
import { defineQuery } from "@bb-kit/core/rpc";
import type { Context } from "@bb-kit/core/plugin";
import { isAllowedPath } from "../domain.ts";
import { gitFor } from "../git.ts";

export const readFile = defineQuery({
  input: z.object({ path: z.string() }).strict(),
  output: z
    .object({
      content: z.string(),
      sha256: z.string(),
      headContent: z.string().nullable(),
    })
    .strict(),
  handler: async (context: Context, { path }) => {
    const git = gitFor(context.bb);
    const repoPath = await git.getRepoPath();
    // Allowlist guard, duplicated with save-file.ts on purpose: rpc/
    // holds only units, so shared micro-logic stays inline.
    const skills = git.repoExists(repoPath) ? git.discoverSkills(repoPath) : [];
    if (!isAllowedPath(path, skills)) {
      throw new Error(`not a tweakable file: ${path}`);
    }
    const [file, headContent] = await Promise.all([
      git.readFile(repoPath, path),
      git.readHeadFile(repoPath, path),
    ]);
    return { ...file, headContent };
  },
});

export type ReadFileResult = z.infer<typeof readFile.output>;
