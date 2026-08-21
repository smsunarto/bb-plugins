import { defineMutation } from "@bb-kit/core/rpc";
import type { Context } from "../server/context.ts";
import {
  type SaveFileResult,
  saveFileInputSchema,
  saveFileOutputSchema,
} from "../server/contract.ts";
import { isAllowedPath, needsRender } from "../server/model.ts";

export const saveFile = defineMutation({
  input: saveFileInputSchema,
  output: saveFileOutputSchema,
  handler: async (
    { repository }: Context,
    { path, content, expectedSha256 },
  ): Promise<SaveFileResult> => {
    const repoPath = await repository.getRepoPath();
    // Allowlist guard, duplicated with read-file.ts on purpose: rpc/
    // holds only units, so shared micro-logic stays inline.
    const skills = repository.repoExists(repoPath) ? repository.discoverSkills(repoPath) : [];
    if (!isAllowedPath(path, skills)) {
      throw new Error(`not a tweakable file: ${path}`);
    }
    const result = await repository.writeFile(repoPath, path, content, expectedSha256);
    if (result.outcome === "conflict") return result;
    return {
      outcome: "written",
      sha256: result.sha256,
      renderHint: needsRender(path),
    };
  },
});
