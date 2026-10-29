import { z } from "zod";
import { isAllowedPath } from "../../shared/domain.ts";
import { requireConnected, requireRepo, type GitContext } from "../git.ts";

export const readFileContract = {
  input: z.object({ hostId: z.string().min(1).optional(), path: z.string() }).strict(),
  output: z
    .object({
      content: z.string(),
      sha256: z.string(),
      headContent: z.string().nullable(),
    })
    .strict(),
};

export type ReadFileResult = z.infer<typeof readFileContract.output>;

export async function readFile(
  ctx: GitContext,
  { hostId, path }: z.output<typeof readFileContract.input>,
): Promise<z.input<typeof readFileContract.output>> {
  const { git } = ctx;
  const repo = requireRepo(await git.inspect(requireConnected(await git.target(hostId))));
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
}
