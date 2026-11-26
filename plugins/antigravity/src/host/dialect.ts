import {
  experimental_planStepsPresentation,
  experimental_presentationDetail,
  experimental_presentationTitle,
  experimental_webSearchPresentation,
  type DeltaItemShape,
  type ThreadEventPlanStep,
} from "@get-bb/plugin-sdk/provider-bridge";
import type {
  AcpClassifiedToolCall,
  AcpDialect,
  AcpToolCallUpdateEvent,
  AcpToolIdentity,
} from "@get-bb/plugin-sdk/provider-bridge/acp";
import { z } from "zod";
import { ANTIGRAVITY_DIALECT_ID } from "../shared/antigravity.ts";
import {
  ANTIGRAVITY_LOGIN_COMMAND,
  antigravityInstallerCommand,
  createAntigravityMaintenanceController,
  resolveAntigravityCommand,
  type AntigravityMaintenanceController,
} from "./maintenance.ts";

const invokeSubagentInputSchema = z
  .object({
    Role: z.string().min(1).optional(),
    TypeName: z.string().min(1).optional(),
    Prompt: z.string().min(1).optional(),
  })
  .passthrough();

const updateStepsInputSchema = z.object({
  steps: z.array(
    z.object({
      title: z.string().min(1),
      status: z.enum(["pending", "in_progress", "done", "skipped", "failed"]),
    }),
  ),
});

const searchWebInputSchema = z
  .object({
    query: z.string().min(1),
  })
  .passthrough();

const toolMetaSchema = z
  .object({
    toolName: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  })
  .passthrough();

function mapStepStatus(
  status: "pending" | "in_progress" | "done" | "skipped" | "failed",
): ThreadEventPlanStep["status"] {
  switch (status) {
    case "in_progress":
      return "active";
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
    case "skipped":
      return "pending";
  }
}

export function readAntigravityToolIdentity(
  event: AcpToolCallUpdateEvent,
): AcpToolIdentity | undefined {
  if (event.name !== undefined && event.name.trim() !== "") {
    return { name: event.name };
  }
  const meta = toolMetaSchema.safeParse(event["_meta"]);
  if (meta.success) {
    const name = meta.data.toolName ?? meta.data.name;
    if (name !== undefined) return { name };
  }
  return undefined;
}

function classifyInvokeSubagent(event: AcpToolCallUpdateEvent): AcpClassifiedToolCall {
  const parsed = invokeSubagentInputSchema.safeParse(event.rawInput);
  const input = parsed.success ? parsed.data : undefined;
  const label = input?.Role ?? input?.TypeName ?? (event.title?.trim() || undefined) ?? "Subagent";
  const rawDetail = input?.TypeName && input.TypeName !== label ? input.TypeName : input?.Prompt;
  const detail = rawDetail === undefined ? undefined : experimental_presentationDetail(rawDetail);
  const shape: DeltaItemShape = {
    type: "delegation",
    childRef: event.toolCallId,
    label,
    background: true,
  };
  return {
    item: shape,
    presentation: {
      label: { pending: "Running subagent", completed: "Ran subagent" },
      icon: { glyph: "Bot" },
      title: experimental_presentationTitle(label),
      ...(detail === undefined ? {} : { detail }),
    },
  };
}

function classifyUpdateSteps(event: AcpToolCallUpdateEvent): AcpClassifiedToolCall | undefined {
  const parsed = updateStepsInputSchema.safeParse(event.rawInput);
  if (!parsed.success || parsed.data.steps.length === 0) return undefined;
  const steps: ThreadEventPlanStep[] = parsed.data.steps.map((step) => ({
    step: step.title,
    status: mapStepStatus(step.status),
  }));
  return {
    item: { type: "planSteps", steps },
    presentation: experimental_planStepsPresentation(steps),
  };
}

function classifySearchWeb(event: AcpToolCallUpdateEvent): AcpClassifiedToolCall | undefined {
  const parsed = searchWebInputSchema.safeParse(event.rawInput);
  if (!parsed.success) return undefined;
  return {
    item: { type: "webSearch", queries: [parsed.data.query] },
    presentation: experimental_webSearchPresentation(parsed.data.query),
  };
}

export function classifyAntigravityToolCall(
  event: AcpToolCallUpdateEvent,
): AcpClassifiedToolCall | undefined {
  const name = event.name ?? readAntigravityToolIdentity(event)?.name;
  if (name === "invoke_subagent" || (name === undefined && isSubagentShape(event.rawInput))) {
    return classifyInvokeSubagent(event);
  }
  if (name === "update_steps") {
    return classifyUpdateSteps(event);
  }
  if (name === "search_web") {
    return classifySearchWeb(event);
  }
  return undefined;
}

function isSubagentShape(rawInput: unknown): boolean {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
    return false;
  }
  return "TypeName" in rawInput && "Role" in rawInput && "Prompt" in rawInput;
}

export function createAntigravityDialect(args?: {
  maintenance?: AntigravityMaintenanceController;
  getCommand?: () => string;
}): AcpDialect {
  const maintenance = args?.maintenance ?? createAntigravityMaintenanceController();
  const getCommand = args?.getCommand ?? (() => resolveAntigravityCommand("agy"));

  return {
    id: ANTIGRAVITY_DIALECT_ID,
    toolIdentity: readAntigravityToolIdentity,
    classifyToolCall: classifyAntigravityToolCall,
    maintenance: {
      loginCommand: ANTIGRAVITY_LOGIN_COMMAND,
      installer: antigravityInstallerCommand,
      readAccount: () => maintenance.readAccount(getCommand()),
      readUsage: () => maintenance.readUsage(getCommand()),
    },
  };
}
