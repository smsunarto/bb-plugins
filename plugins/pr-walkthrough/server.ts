// bb-plugin-pr-walkthrough — backend entry.
//
// The walkthrough is produced by the bundled `pr-walkthrough` skill
// (skills/pr-walkthrough/), which agents run inside a thread. The skill's
// compiler (scripts/compile_walkthrough.py) turns canonical MDX plus a Git
// patch into walkthrough.generated.json; this backend reads that file from the
// thread's workspace so the frontend can render the walkthrough natively with
// bb's own diff renderer. There is no static site: the compiled JSON is the
// only artifact, and this panel is the renderer.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

export const DEFAULT_SITE_DIR = ".pr-walkthrough";

const GENERATED_DATA_PATH = "walkthrough.generated.json";

// compile_walkthrough.py is the single producer of this shape.
export type WalkthroughGuideBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language?: string; code: string }
  | { type: "quote"; text: string };

export type WalkthroughGuideComment = {
  id: string;
  side: "deletions" | "additions";
  lineNumber: number;
  body: string;
};

export type WalkthroughGuideExcerpt = {
  id: string;
  title: string;
  explanation: WalkthroughGuideBlock[];
  path: string;
  url: string;
  patch: string;
  rangeLabel: string;
  additions: number;
  deletions: number;
  binary: boolean;
  generated: boolean;
  countsTowardCompletion: boolean;
  defaultCollapsed: boolean;
  comments: WalkthroughGuideComment[];
};

export type WalkthroughGuidePhase = {
  id: string;
  title: string;
  explanation: WalkthroughGuideBlock[];
  excerpts: WalkthroughGuideExcerpt[];
  defaultCollapsed: boolean;
};

export type WalkthroughReviewGroup = {
  id: string;
  title: string;
  objective: string;
  summary: string;
  details: string[];
  files: Array<{ path: string; url?: string; note?: string }>;
  comments: Array<{ author: string; body: string; url?: string }>;
  links: Array<{ label: string; url: string }>;
  guide: { phases: WalkthroughGuidePhase[] };
};

export type WalkthroughDiffFile = {
  path: string;
  previousPath?: string;
  status: "added" | "copied" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
  binary: boolean;
  generated: boolean;
  generatedReason?: string;
  url: string;
};

export type WalkthroughData = {
  meta: {
    title: string;
    prUrl: string;
    baseRef: string;
    headRef: string;
    headSha: string;
    summary: string;
  };
  reviewGroups: WalkthroughReviewGroup[];
  diffFiles: WalkthroughDiffFile[];
};

export const rpcContract = defineRpcContract({
  getWalkthrough: {
    input: z
      .object({
        threadId: z.string().min(1),
        // Workspace-relative walkthrough site directory (the scaffold output).
        path: z.string().min(1).max(1024).optional(),
      })
      .strict(),
    output: z.object({
      walkthrough: z.custom<WalkthroughData | null>(
        (value) => value === null || typeof value === "object",
      ),
      error: z.string().nullable(),
    }),
  },
});

// Directive attributes round-trip through the model and panel params, so the
// relative path is untrusted input: keep it inside the workspace.
export function normalizeRelativeDir(path: string | undefined): string | null {
  const candidate = (path ?? DEFAULT_SITE_DIR).replaceAll("\\", "/");
  if (candidate.startsWith("/") || candidate.includes("\0")) return null;
  const segments = candidate.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.some((s) => s === "..")) return null;
  // Directives written before the static site was removed pointed at the site
  // source (".pr-walkthrough/site") or its export (".../site/out"). Both now
  // resolve to the directory that holds the compiled JSON.
  if (segments[segments.length - 1] === "out") segments.pop();
  if (segments[segments.length - 1] === "site") segments.pop();
  if (segments.length === 0) return null;
  return segments.join("/");
}

function isWalkthroughData(value: unknown): value is WalkthroughData {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  const meta = data.meta as Record<string, unknown> | undefined;
  return (
    typeof meta === "object" &&
    meta !== null &&
    typeof meta.title === "string" &&
    Array.isArray(data.reviewGroups) &&
    Array.isArray(data.diffFiles)
  );
}

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    async getWalkthrough({ threadId, path }) {
      const failure = (error: string) => ({ walkthrough: null, error });

      const relativeDir = normalizeRelativeDir(path);
      if (relativeDir === null) {
        return failure(
          "The walkthrough path must be a workspace-relative directory.",
        );
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
      if (!isWalkthroughData(parsed)) {
        return failure(
          "The compiled walkthrough data does not match the expected shape. " +
            "Regenerate it with the skill's compile step.",
        );
      }
      return { walkthrough: parsed, error: null };
    },
  });
}
