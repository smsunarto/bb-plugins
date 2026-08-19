// @smsunarto/bb-plugin-pr-walkthrough — backend entry.
//
// The walkthrough is produced by the bundled `pr-walkthrough` skill
// (skills/pr-walkthrough/), which agents run inside a thread. The skill's
// compiler emits structured data (walkthrough.generated.json) at scaffold
// time; this backend reads that file from the thread's workspace so the
// frontend can render the walkthrough natively with bb's own diff renderer.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const DEFAULT_SITE_DIR = ".pr-walkthrough/site";

const GENERATED_DATA_PATH = "src/data/walkthrough.generated.json";

// Mirrors the site template's src/data/walkthrough.ts contract. The compiler
// (scripts/compile-walkthrough.ts) is the single producer of this shape.
const nonNegativeInteger = z.number().int().nonnegative();

const walkthroughGuideBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("list"),
      ordered: z.boolean(),
      items: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      type: z.literal("code"),
      language: z.string().optional(),
      code: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("quote"), text: z.string() }).strict(),
]);

const walkthroughGuideCommentSchema = z
  .object({
    id: z.string().min(1),
    side: z.enum(["deletions", "additions"]),
    lineNumber: z.number().int().positive(),
    body: z.string(),
  })
  .strict();

const walkthroughGuideDiagramSchema = z
  .object({
    summary: z.string(),
    nodes: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string(),
            detail: z.string().optional(),
            x: z.number().finite(),
            y: z.number().finite(),
          })
          .strict(),
      )
      .min(2),
    edges: z
      .array(
        z
          .object({
            id: z.string().min(1),
            source: z.string().min(1),
            target: z.string().min(1),
            label: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const walkthroughGuideExcerptSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    explanation: z.array(walkthroughGuideBlockSchema),
    path: z.string().min(1),
    url: z.string(),
    patch: z.string(),
    rangeLabel: z.string(),
    additions: nonNegativeInteger,
    deletions: nonNegativeInteger,
    binary: z.boolean(),
    generated: z.boolean(),
    countsTowardCompletion: z.boolean(),
    defaultCollapsed: z.boolean(),
    comments: z.array(walkthroughGuideCommentSchema),
  })
  .strict();

const walkthroughGuidePhaseSchema = z
  .object({
    id: z.enum(["foundations", "apis", "behavior", "integration", "tests", "misc", "generated"]),
    title: z.string(),
    explanation: z.array(walkthroughGuideBlockSchema),
    diagram: walkthroughGuideDiagramSchema.optional(),
    excerpts: z.array(walkthroughGuideExcerptSchema).min(1),
    defaultCollapsed: z.boolean(),
  })
  .strict();

const walkthroughReviewGroupSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    objective: z.string(),
    summary: z.string(),
    details: z.array(z.string()),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1),
            url: z.string().optional(),
            note: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
    comments: z.array(
      z
        .object({
          author: z.string(),
          body: z.string(),
          url: z.string().optional(),
        })
        .strict(),
    ),
    links: z.array(z.object({ label: z.string(), url: z.string() }).strict()),
    guide: z.object({ phases: z.array(walkthroughGuidePhaseSchema).min(1) }).strict(),
  })
  .strict();

const walkthroughDiffFileSchema = z
  .object({
    path: z.string().min(1),
    previousPath: z.string().optional(),
    status: z.enum(["added", "copied", "deleted", "modified", "renamed"]),
    additions: nonNegativeInteger,
    deletions: nonNegativeInteger,
    patch: z.string(),
    oldContents: z.string().optional(),
    newContents: z.string().optional(),
    binary: z.boolean(),
    generated: z.boolean(),
    generatedReason: z.string().optional(),
    url: z.string(),
  })
  .strict();

export const walkthroughDataSchema = z
  .object({
    meta: z
      .object({
        title: z.string(),
        prUrl: z.string(),
        baseRef: z.string(),
        headRef: z.string(),
        headSha: z.string(),
        summary: z.string(),
      })
      .strict(),
    reviewGroups: z.array(walkthroughReviewGroupSchema).min(1),
    diffFiles: z.array(walkthroughDiffFileSchema).min(1),
  })
  .strict();

export type WalkthroughGuideBlock = z.infer<typeof walkthroughGuideBlockSchema>;
export type WalkthroughGuideComment = z.infer<typeof walkthroughGuideCommentSchema>;
export type WalkthroughGuideDiagram = z.infer<typeof walkthroughGuideDiagramSchema>;
export type WalkthroughGuideExcerpt = z.infer<typeof walkthroughGuideExcerptSchema>;
export type WalkthroughGuidePhase = z.infer<typeof walkthroughGuidePhaseSchema>;
export type WalkthroughReviewGroup = z.infer<typeof walkthroughReviewGroupSchema>;
export type WalkthroughDiffFile = z.infer<typeof walkthroughDiffFileSchema>;
export type WalkthroughData = z.infer<typeof walkthroughDataSchema>;

export const rpcContract = defineRpcContract({
  getWalkthrough: {
    input: z
      .object({
        threadId: z.string().min(1),
        // Workspace-relative walkthrough site directory (the scaffold output).
        path: z.string().min(1).max(1024).optional(),
      })
      .strict(),
    output: z
      .object({
        walkthrough: walkthroughDataSchema.nullable(),
        error: z.string().nullable(),
      })
      .strict(),
  },
});

// Directive attributes round-trip through the model and panel params, so the
// relative path is untrusted input: keep it inside the workspace.
export function normalizeRelativeDir(path: string | undefined): string | null {
  const candidate = (path ?? DEFAULT_SITE_DIR).replaceAll("\\", "/");
  if (candidate.startsWith("/") || candidate.includes("\0")) return null;
  const segments = candidate.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.some((s) => s === "..")) return null;
  // Earlier directives pointed at the static export dir; the compiled data
  // lives one level up in the site source.
  if (segments[segments.length - 1] === "out") segments.pop();
  return segments.join("/");
}

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    async getWalkthrough({ threadId, path }) {
      const failure = (error: string) => ({ walkthrough: null, error });

      const relativeDir = normalizeRelativeDir(path);
      if (relativeDir === null) {
        return failure("The walkthrough path must be a workspace-relative directory.");
      }

      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.environmentId === null) {
        return failure("This thread has no workspace environment.");
      }
      const environment = await bb.sdk.environments.get({
        environmentId: thread.environmentId,
      });
      if (environment.path === null) {
        return failure("The thread's environment has no workspace path.");
      }

      const workspaceRoot = environment.path.replace(/\/+$/, "");
      const dataPath = `${workspaceRoot}/${relativeDir}/${GENERATED_DATA_PATH}`;

      let content: string;
      try {
        const file = await bb.sdk.files.read({
          hostId: environment.hostId,
          path: dataPath,
          rootPath: workspaceRoot,
        });
        content =
          file.contentEncoding === "base64"
            ? Buffer.from(file.content, "base64").toString("utf8")
            : file.content;
      } catch (error) {
        bb.log.warn(
          `getWalkthrough read failed for ${dataPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return failure(
          `No compiled walkthrough at ${relativeDir}/${GENERATED_DATA_PATH}. ` +
            "Ask the agent to run the pr-walkthrough skill, then retry.",
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return failure("The compiled walkthrough data is not valid JSON.");
      }
      const result = walkthroughDataSchema.safeParse(parsed);
      if (!result.success) {
        return failure(
          "The compiled walkthrough data does not match the expected shape. " +
            "Regenerate it with the skill's scaffold step.",
        );
      }
      return { walkthrough: result.data, error: null };
    },
  });
}
