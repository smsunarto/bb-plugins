import { z } from "zod";

/** Where the dotfiles checkout keeps the sources this importer reads. */
export const DOTFILES_AGENTS = ".dotfiles/.agents";
/** One host call returns at most this much file content (the daemon caps output at 8 MiB). */
export const MAX_TREE_BYTES = 5 * 1024 * 1024;

const rootPath = z.string().min(1);
const relativePath = z
  .string()
  .min(1)
  .refine(
    (path) => !path.includes("\\") && path.split("/").every((s) => s && s !== "." && s !== ".."),
    "must be a plain relative path",
  );

/** Plain method definitions; `src/host-contract.ts` combines them with the documents methods. */
export const catalogHostMethods = {
  listAgentSources: {
    experimental_retryable: true,
    input: z.object({ rootPath }).strict(),
    output: z
      .object({
        /** File names directly inside the instructions folder. */
        instructions: z.array(z.string()),
        /** Skill folders, relative to the checkout, with the plugin that ships them. */
        skills: z.array(z.object({ dir: z.string(), plugin: z.string().nullable() }).strict()),
        /** Linked skill folders, plugin folders, or instruction files; never followed. */
        links: z.array(z.string()),
      })
      .strict(),
  },
  readSkillTree: {
    experimental_retryable: true,
    input: z.object({ rootPath, dir: relativePath }).strict(),
    output: z
      .object({
        files: z.array(
          z.object({ path: z.string(), executable: z.boolean(), base64: z.string() }).strict(),
        ),
        /** Links inside the tree; bb refuses a skill that contains any. */
        symlinks: z.array(z.string()),
        /** The tree is larger than one call may return; no files are included. */
        tooLarge: z.boolean(),
      })
      .strict(),
  },
  readText: {
    experimental_retryable: true,
    input: z.object({ rootPath, path: relativePath }).strict(),
    output: z.object({ content: z.string().nullable() }).strict(),
  },
};
