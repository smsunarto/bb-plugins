import type { BbPluginApi, PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_ROUTE,
  DEFAULT_GENERAL_RULE,
  MODELS,
  DEFAULT_ENABLED_ROUTES,
  ruleSettingKey,
  routeEnabledKey,
  modelEnabledKey,
  enabledRouteIds,
  ROUTES,
  projectIndexSchema,
  type ModelRule,
  type ProjectEntry,
} from "../../../shared/autorouter/policy.ts";

const projectIndexTextSchema = z
  .string()
  .max(512_000)
  .superRefine((text, ctx) => {
    try {
      const parsed = projectIndexSchema.safeParse(JSON.parse(text));
      if (!parsed.success)
        ctx.addIssue({
          code: "custom",
          message: parsed.error.issues.map((issue) => issue.message).join(" "),
        });
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Enter a JSON array of repository entries, or run /index-projects.",
      });
    }
  });

const descriptors = {
  autorouterEnabled: {
    type: "boolean",
    label: "Autorouter",
    description:
      "Show the composer autorouter. New threads can route project and model. Follow-ups can change Astra reasoning or escalate Luna Max to Astra.",
    default: false,
  },

  autorouterModelRouting: { type: "boolean", label: "Autorouter: model routing", default: true },
  autorouterProjectRouting: {
    type: "boolean",
    label: "Autorouter: project routing",
    description: "Choose a project for new threads.",
    default: true,
  },
  autorouterGeneralRule: {
    type: "string",
    label: "Autorouter: general routing rule",
    experimental_multiline: true,
    experimental_schema: z.string().max(8_000),
    default: DEFAULT_GENERAL_RULE,
  },
  ...Object.fromEntries(
    MODELS.map((model) => [
      modelEnabledKey(model.key),
      {
        type: "boolean" as const,
        label: `Autorouter: enable ${model.label}`,
        default: model.key !== "sol",
      },
    ]),
  ),
  ...Object.fromEntries(
    ROUTES.map((route) => [
      routeEnabledKey(route.id),
      {
        type: "boolean" as const,
        label: `Autorouter: enable ${route.label}`,
        default: DEFAULT_ENABLED_ROUTES.has(route.id),
      },
    ]),
  ),
  autorouterFallback: {
    type: "select",
    label: "Autorouter fallback model and reasoning",
    description:
      "Used when routing is uncertain. Disabled or unavailable fallbacks use another enabled route. Follow-ups preserve their current selection on failure.",
    options: ROUTES.map((route) => route.id),
    default: DEFAULT_ROUTE,
  },
  autorouterProjectIndex: {
    type: "string",
    label: "Autorouter project index",
    description:
      "Run /index-projects to index ~/git. Each JSON entry has repository, path, hostId, projectId (or null), summary, and exactly three distinct examples. You can edit entries here.",
    experimental_multiline: true,
    experimental_schema: projectIndexTextSchema,
    default: "[]",
  },
  ...Object.fromEntries(
    ROUTES.map((route) => [
      ruleSettingKey(route.id),
      {
        type: "string" as const,
        label: `Autorouter: when to use ${route.label}`,
        description: "Guidance supplied to Luna when it chooses a model and reasoning level.",
        experimental_multiline: true,
        experimental_schema: z
          .string()
          .max(4_000)
          .refine((value) => value.trim().length > 0, "Enter routing guidance."),
        default: route.prompt,
      },
    ]),
  ),
} satisfies Record<string, PluginSettingDescriptor>;

export interface AutorouterSettings {
  enabled: boolean;
  modelRouting: boolean;
  projectRouting: boolean;
  generalRule: string;
  enabledRoutes: Set<string>;
  fallback: string;
  projects: ProjectEntry[];
  rules: ModelRule[];
}

type Handle = ReturnType<typeof defineSettings>;
const handles = new WeakMap<BbPluginApi, Handle>();
const snapshots = new WeakMap<BbPluginApi, Record<string, unknown>>();
export function autorouterAgentEnabled(bb: BbPluginApi): boolean {
  const values = snapshots.get(bb);
  return values?.autorouterEnabled === true && values.autorouterModelRouting !== false;
}

function defineSettings(bb: BbPluginApi) {
  return bb.settings.define(descriptors);
}

export async function registerAutorouterSettings(bb: BbPluginApi): Promise<void> {
  const handle = defineSettings(bb);
  handles.set(bb, handle);
  handle.onChange((values) => snapshots.set(bb, values));
  bb.onDispose(() => {
    handles.delete(bb);
    snapshots.delete(bb);
  });
  snapshots.set(bb, await handle.get());
}

function settingsHandle(bb: BbPluginApi): Handle {
  const handle = handles.get(bb);
  if (!handle) throw new Error("Autorouter settings are not initialized.");
  return handle;
}

export async function readAutorouterSettings(bb: BbPluginApi): Promise<AutorouterSettings> {
  const values = await settingsHandle(bb).get();
  const ruleValues: Record<string, unknown> = values;
  return {
    enabled: values.autorouterEnabled,
    modelRouting: values.autorouterModelRouting,
    projectRouting: values.autorouterProjectRouting,
    generalRule: values.autorouterGeneralRule,
    enabledRoutes: enabledRouteIds(ruleValues),
    fallback: values.autorouterFallback,
    projects: projectIndexSchema.parse(JSON.parse(values.autorouterProjectIndex)),
    rules: ROUTES.map((route) => ({
      route: route.id,
      prompt: String(ruleValues[ruleSettingKey(route.id)] ?? route.prompt),
    })),
  };
}

export async function setAutorouterEnabled(bb: BbPluginApi, enabled: boolean): Promise<void> {
  await settingsHandle(bb).experimental_set({ autorouterEnabled: enabled });
}

export async function updateAutorouterSettings(
  bb: BbPluginApi,
  values: Record<string, string | boolean>,
): Promise<void> {
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(descriptors, key)) throw new Error(`Unknown autorouter setting: ${key}`);
  }
  if (typeof values.autorouterProjectIndex === "string") {
    await validateProjectEntries(
      bb,
      projectIndexSchema.parse(JSON.parse(values.autorouterProjectIndex)),
    );
  }
  await settingsHandle(bb).experimental_set(values);
}

async function validateProjectEntries(bb: BbPluginApi, entries: ProjectEntry[]): Promise<void> {
  const known = new Set((await bb.sdk.projects.list()).map((project) => project.id));
  for (const entry of entries) {
    if (entry.projectId !== null && !known.has(entry.projectId)) {
      throw new Error(
        `Unknown BB project for ${entry.repository}. Use a known project ID or null.`,
      );
    }
  }
}

export async function saveProjectIndex(bb: BbPluginApi, entries: ProjectEntry[]): Promise<void> {
  await validateProjectEntries(bb, entries);
  await settingsHandle(bb).experimental_set({
    autorouterProjectIndex: JSON.stringify(projectIndexSchema.parse(entries), null, 2),
  });
}
