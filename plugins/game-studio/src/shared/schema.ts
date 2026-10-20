// Canvas file shapes adapted from WhiteTowerAI/ohmygame at 2cec05e4af5c.
// Modified for BB: Zod boundaries, native project identity, no provider credentials.
// Original source is licensed under Apache-2.0; see ../../THIRD_PARTY_NOTICES.md.
import { z } from "zod";
import { generationJob } from "./generation.ts";

export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const position = z.object({ x: z.number().finite(), y: z.number().finite() });
export const nodeKindSchema = z.enum([
  "text",
  "image",
  "video",
  "model-3d",
  "animate-3d",
  "agent",
  "asset",
  "document",
  "table",
]);
export const nodeSchema = z.object({
  id: idSchema,
  type: nodeKindSchema,
  title: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
  position,
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  data: z.record(z.string(), z.json()),
});
export const boardSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  name: z.string().max(120).optional(),
  viewport: z.object({ width: z.number().positive(), height: z.number().positive() }),
  nodes: z.array(nodeSchema).max(2000),
  edges: z
    .array(
      z.object({
        id: idSchema,
        source: idSchema,
        target: idSchema,
        sourceHandle: z.string().optional(),
      }),
    )
    .max(8000),
  editorLayout: z.object({
    version: z.literal(1),
    view: z.literal("canvas"),
    nodes: z.record(
      z.string(),
      position.extend({
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
      }),
    ),
    viewport: position.extend({ zoom: z.number().positive() }),
    fitView: z.boolean().optional(),
  }),
});
export const indexSchema = z.object({
  version: z.literal(1),
  mainDocumentId: idSchema.optional(),
  boards: z
    .array(z.object({ id: idSchema, name: z.string().min(1).max(120) }))
    .min(1)
    .max(100),
  documents: z.array(z.object({ id: idSchema, title: z.string().max(200) })).max(200),
  tables: z
    .array(z.object({ id: idSchema, title: z.string().max(200) }))
    .max(200)
    .optional(),
});
export const unitySetupSchema = z.object({
  version: z.string().trim().min(1).max(100).nullable(),
  template: z.enum(["3d-urp", "2d-urp", "empty"]),
});
export const requestActionSchema = z.enum([
  "design",
  "build",
  "asset",
  "playtest",
  "connect",
  "import",
  "new-unity",
]);
export const requestDescriptorSchema = z.object({
  id: idSchema,
  action: requestActionSchema,
  createdAt: z.number().int().min(0).max(8.64e15),
});
export const unityRequestSchema = requestDescriptorSchema.extend({
  threadId: z.string().min(1).max(200),
  status: z.enum(["queued", "running", "done", "failed", "uncertain"]),
  detail: z.string().max(2000).optional(),
});
export const gameSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  projectId: z.string(),
  hostId: z.string(),
  rootPath: z.string(),
  kind: z.enum(["unity", "web", "story", "general"]),
  createdAt: z.number(),
  threadId: z.string().nullable(),
  previewPath: z.string().default("index.html"),
  unitySetup: unitySetupSchema.optional(),
});
export const assetSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  type: z.enum(["image", "video", "audio", "model", "file"]),
});
export const documentSchema = z.object({
  id: idSchema,
  title: z.string(),
  markdown: z.string(),
  revision: z.string(),
});
export const evidenceRunSchema = z.object({
  id: idSchema,
  capturedAtMs: z.number().int().min(0).max(8.64e15),
  scene: z.string().min(1).max(200).optional(),
  outcome: z.enum(["pass", "fail"]).optional(),
  threadId: z.string().min(1).max(200).optional(),
  testedRevision: z.string().trim().min(1).max(200).optional(),
  experiment: z
    .strictObject({
      documentId: idSchema,
      documentRevision: z.string().trim().min(1).max(200),
      experimentId: idSchema,
      definition: z
        .strictObject({
          question: z.string().trim().min(1).max(500),
          criterion: z.string().trim().min(1).max(1000),
          setup: z.string().trim().min(1).max(2000),
        })
        .optional(),
    })
    .optional(),
  files: z.array(assetSchema).min(1).max(100),
});
export const workspaceSchema = z.object({
  game: gameSchema,
  index: indexSchema,
  indexRevision: z.string(),
  boards: z.array(z.object({ board: boardSchema, revision: z.string() })),
  documents: z.array(documentSchema),
  assets: z.array(assetSchema),
  evidence: z.array(assetSchema).default([]),
  evidenceRuns: z.array(evidenceRunSchema).default([]),
  requests: z.array(unityRequestSchema).default([]),
  generationJobs: z.array(generationJob).default([]),
  unityVersion: z.string().nullable().optional(),
});
export const gameInput = z.object({ gameId: idSchema });
export const revisionInput = z.string().nullable();
export const previewSchema = z.object({ baseUrl: z.string(), expiresAtMs: z.number() });
export const overviewSchema = z.object({
  games: z.array(gameSchema),
  hosts: z.array(z.object({ id: z.string(), name: z.string(), online: z.boolean() })),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
});
export const createGameInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    hostId: z.string().min(1),
    rootPath: z.string().min(1).max(4000),
    kind: gameSchema.shape.kind,
    unitySetup: unitySetupSchema.optional(),
  })
  .strict();
export const attachGameInput = z
  .object({
    projectId: z.string().min(1),
    hostId: z.string().min(1),
    rootPath: z.string().min(1).max(4000),
    kind: gameSchema.shape.kind.optional(),
  })
  .strict();
export const revisionSchema = z.object({ revision: z.string() });
export const saveBoardInput = gameInput
  .extend({ board: boardSchema, revision: z.string() })
  .strict();
export const saveDocumentInput = gameInput
  .extend({
    documentId: idSchema,
    markdown: z.string().max(4 * 1024 * 1024),
    revision: z.string(),
  })
  .strict();
export const createDocumentInput = gameInput
  .extend({ title: z.string().trim().min(1).max(200) })
  .strict();
export const createBoardInput = gameInput
  .extend({ name: z.string().trim().min(1).max(120) })
  .strict();
export const updateGameInput = gameInput
  .extend({
    threadId: z.string().nullable().optional(),
    previewPath: z.string().min(1).max(1000).optional(),
  })
  .strict();
export const uploadAssetInput = gameInput
  .extend({
    name: z.string().trim().min(1).max(200),
    content: z.string().max(28 * 1024 * 1024),
  })
  .strict();
export const generationRecipeSchema = z.enum([
  "concept-art",
  "nano-banana",
  "omni-video",
  "fal-video",
  "model-3d",
  "tripo-texture",
  "tripo-pbr",
  "tripo-rig",
  "tripo-animate",
  "voice-sfx",
  "music",
]);
export const promptInput = gameInput
  .extend({
    action: requestActionSchema,
    boardId: idSchema.optional(),
    nodeId: idSchema.optional(),
    documentId: idSchema.optional(),
    experimentId: idSchema.optional(),
    assetId: z.string().min(1).max(1000).optional(),
    recipe: generationRecipeSchema.optional(),
  })
  .strict()
  .refine(({ action, assetId }) => assetId === undefined || action === "import", {
    path: ["assetId"],
    error: "Select an asset only for an import request.",
  });
export const promptSchema = z.object({
  prompt: z.string(),
  context: z.string(),
  request: requestDescriptorSchema,
});
export const recordRequestInput = gameInput
  .extend({
    request: requestDescriptorSchema,
    threadId: unityRequestSchema.shape.threadId,
    status: z.enum(["queued", "running"]),
  })
  .strict();
export const inspectUnityInput = z
  .object({
    hostId: z.string().min(1),
    rootPath: z.string().min(1).max(4000),
  })
  .strict();
export const inspectUnitySchema = z.object({ version: z.string().nullable() });
export type Game = z.infer<typeof gameSchema>;
export type Board = z.infer<typeof boardSchema>;
export type CanvasNode = z.infer<typeof nodeSchema>;
export type NodeKind = z.infer<typeof nodeKindSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type EvidenceRun = z.infer<typeof evidenceRunSchema>;
export type StudioDocument = z.infer<typeof documentSchema>;
export type GenerationRecipe = z.infer<typeof generationRecipeSchema>;
export type RequestDescriptor = z.infer<typeof requestDescriptorSchema>;
export type UnityRequest = z.infer<typeof unityRequestSchema>;
