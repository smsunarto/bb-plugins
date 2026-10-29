import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const sourceSchema = z
  .object({
    scope: z.enum(["global", "project"]),
    projectId: z.string().min(1),
    sourceId: z.string().min(1),
    hostId: z.string().min(1),
    rootPath: z.string().min(1),
  })
  .strict();
export type DocumentSource = z.infer<typeof sourceSchema>;
export const fileSchema = sourceSchema.extend({ path: z.string().min(1).max(2048) });
export type DocumentFile = z.infer<typeof fileSchema>;
export const MAX_TEXT_BYTES = 1_048_576;
export { textFilePattern as textExtensions } from "../shared/text-files.ts";
import { textFilePattern as textExtensions } from "../shared/text-files.ts";

/** The narrow authored directory that the native file API confines each operation to. */
export function documentBoundary(scope: DocumentSource["scope"], path: string): string | null {
  if (path.includes("\\") || path.split("/").some((s) => !s || s === "." || s === ".."))
    return null;
  if (
    !textExtensions.test(path) ||
    path.split("/").some((s) => s.startsWith(".bb-tmp") || s === "node_modules" || s === ".git")
  )
    return null;
  if (scope === "global") {
    if (path.startsWith(".dotfiles/.agents/instructions/")) return ".dotfiles/.agents/instructions";
    const skill = path.match(
      /^(\.dotfiles\/\.agents\/(?:skills\/[^/]+|plugins\/[^/]+\/skills\/[^/]+))\//,
    );
    return skill?.[1] ?? null;
  }
  if (path === "AGENTS.md" || path === "CLAUDE.md") return ".";
  if (path === ".bb/AGENTS.md") return ".bb";
  const skill = path.match(/^(\.(?:agents|bb|claude|codex)\/skills\/[^/]+)\//);
  return skill?.[1] ?? null;
}

export const metadataSchema = z.object({
  globalProjectId: z.string().nullable(),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      sources: z.array(
        z.object({
          id: z.string(),
          hostId: z.string(),
          rootPath: z.string(),
          hostName: z.string(),
          connected: z.boolean(),
          isDefault: z.boolean(),
        }),
      ),
    }),
  ),
});
export type DocumentMetadata = z.infer<typeof metadataSchema>;

export const documentHostContract = defineRpcContract({
  inspectPath: {
    experimental_retryable: true,
    input: z
      .object({ rootPath: z.string(), path: z.string(), readOnlyLinks: z.boolean().optional() })
      .strict(),
    output: z
      .object({
        rootPath: z.string(),
        exists: z.boolean(),
        resolvedPath: z.string().optional(),
        linked: z.boolean().optional(),
      })
      .strict(),
  },
});

export const documentContracts = {
  documentSources: { input: z.null(), output: metadataSchema },
  setGlobalProject: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.null(),
  },
  documentFiles: {
    input: sourceSchema.extend({ query: z.string().max(200).optional() }),
    output: z.object({
      files: z.array(z.string()),
      truncated: z.boolean(),
      warnings: z.array(z.string()),
    }),
  },
  readDocument: {
    input: fileSchema,
    output: z.object({
      content: z.string(),
      sha256: z.string().nullable(),
      readOnly: z.string().nullable(),
    }),
  },
  saveDocument: {
    input: fileSchema.extend({
      content: z.string().max(MAX_TEXT_BYTES),
      expectedSha256: z.string().nullable(),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("written"), sha256: z.string() }),
      z.object({ outcome: z.literal("conflict") }),
    ]),
  },
  applyDocuments: {
    input: sourceSchema.extend({ task: z.enum(["render", "install:agent-plugins"]) }),
    output: z.object({ exitCode: z.number().int(), output: z.string() }),
  },
};

export type StoredDocument = z.infer<typeof documentContracts.readDocument.output>;
