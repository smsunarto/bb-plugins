import { z } from "zod";
import { defineMutation } from "@bb-kit/core/rpc";
import { isAllowedPath, needsRender } from "../../shared/domain.ts";
import type { GitContext } from "../git.ts";

export const saveFile = defineMutation({
  input: z
    .object({
      hostId: z.string().min(1).optional(),
      path: z.string(),
      content: z.string(),
      expectedSha256: z.string().optional(),
    })
    .strict(),
  output: z.discriminatedUnion("outcome", [
    z
      .object({
        outcome: z.literal("written"),
        sha256: z.string(),
        renderHint: z.boolean(),
      })
      .strict(),
    z.object({ outcome: z.literal("conflict") }).strict(),
  ]),
  async execute(ctx: GitContext, { hostId, path, content, expectedSha256 }) {
    const { git } = ctx;
    const repo = await git.inspect(await git.target(hostId));
    // Allowlist guard, duplicated with read-file.ts on purpose: rpc/
    // holds only units, so shared micro-logic stays inline.
    if (!isAllowedPath(path, repo.skills)) {
      throw new Error(`not a tweakable file: ${path}`);
    }
    const result = await git.writeFile(repo, path, content, expectedSha256);
    if (result.outcome === "conflict") return result;
    return {
      outcome: "written" as const,
      sha256: result.sha256,
      renderHint: needsRender(path),
    };
  },
});

export type SaveFileResult = z.infer<typeof saveFile.output>;
