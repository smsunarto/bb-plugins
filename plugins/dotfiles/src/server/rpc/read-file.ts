import { z } from "zod";
import { defineQuery } from "@bb-kit/core/rpc";
import { isAllowedPath } from "../../shared/domain.ts";
import type { GitContext } from "../git.ts";

export const readFile = defineQuery({
  input: z.object({ hostId: z.string().min(1).optional(), path: z.string() }).strict(),
  output: z
    .object({
      content: z.string(),
      sha256: z.string(),
      headContent: z.string().nullable(),
    })
    .strict(),
  async execute(ctx: GitContext, { hostId, path }) {
    const { git } = ctx;
    const repo = await git.inspect(await git.target(hostId));
    // Allowlist guard, duplicated with save-file.ts on purpose: rpc/
    // holds only units, so shared micro-logic stays inline.
    if (!isAllowedPath(path, repo.skills)) {
      throw new Error(`not a tweakable file: ${path}`);
    }
    const [file, headContent] = await Promise.all([
      git.readFile(repo, path),
      git.readHeadFile(repo, path),
    ]);
    return { ...file, headContent };
  },
});

export type ReadFileResult = z.infer<typeof readFile.output>;
