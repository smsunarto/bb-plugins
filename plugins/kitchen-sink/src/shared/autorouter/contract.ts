import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  aiInferenceCompleteInputSchema,
  aiInferenceCompleteOutputSchema,
} from "@bb-plugins/codex-inference/contract";

export const autorouterHostContract = defineRpcContract({
  complete: { input: aiInferenceCompleteInputSchema, output: aiInferenceCompleteOutputSchema },
});

export const routeAutorouterPromptInputSchema = z.strictObject({
  prompt: z.string().max(200_000),
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("new-thread"), projectId: z.string().nullable() }),
    z.strictObject({
      kind: z.literal("thread"),
      threadId: z.string().min(1),
      selectionTitle: z.string().max(300),
    }),
  ]),
});

const executionSchema = z.strictObject({
  route: z.string(),
  providerId: z.string(),
  providerLabel: z.string(),
  model: z.string(),
  modelLabel: z.string(),
  reasoningLevel: z.string(),
  reasoningLabel: z.string(),
});
export type AutorouterExecution = z.infer<typeof executionSchema>;
const autorouterRouteSchema = z.strictObject({
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  execution: executionSchema.nullable(),
  usedFallback: z.boolean(),
  projectReason: z.string(),
  modelReason: z.string(),
});
export const routeAutorouterPromptOutputSchema = z.strictObject({
  decision: autorouterRouteSchema.nullable(),
});
export type AutorouterRoute = z.infer<typeof autorouterRouteSchema>;
export type AutorouterScope =
  | { kind: "new-thread"; projectId: string | null }
  | { kind: "thread"; threadId: string };

export const updateAutorouterEnabledInputSchema = z.strictObject({ enabled: z.boolean() });
export const updateAutorouterEnabledOutputSchema = z.strictObject({ enabled: z.boolean() });

export type AutorouterRpcContract = {
  routeAutorouterPrompt: {
    input: typeof routeAutorouterPromptInputSchema;
    output: typeof routeAutorouterPromptOutputSchema;
  };
  updateAutorouterEnabled: {
    input: typeof updateAutorouterEnabledInputSchema;
    output: typeof updateAutorouterEnabledOutputSchema;
  };
};
