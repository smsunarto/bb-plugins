import type { BbPluginApi, PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_ROUTE,
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

export function ruleSettingKey(route: string): string {
  return `autorouterRule_${route.replaceAll("/", "_")}`;
}

const descriptors = {
  autorouterEnabled: {
    type: "boolean",
    label: "Autorouter",
    description:
      "Automatically select project, model, and reasoning for new threads. Follow-ups only route Astra reasoning. Other models keep their selections.",
    default: false,
  },
  autorouterFallback: {
    type: "select",
    label: "Autorouter fallback model and reasoning",
    description:
      "Used for new threads when routing is uncertain or inference fails. Astra follow-ups keep their current reasoning on failure.",
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
  fallback: string;
  projects: ProjectEntry[];
  rules: ModelRule[];
}

type Handle = ReturnType<typeof defineSettings>;
const handles = new WeakMap<BbPluginApi, Handle>();

function defineSettings(bb: BbPluginApi) {
  return bb.settings.define(descriptors);
}

export function registerAutorouterSettings(bb: BbPluginApi): void {
  handles.set(bb, defineSettings(bb));
  bb.onDispose(() => {
    handles.delete(bb);
  });
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

export async function saveProjectIndex(bb: BbPluginApi, entries: ProjectEntry[]): Promise<void> {
  await settingsHandle(bb).experimental_set({
    autorouterProjectIndex: JSON.stringify(projectIndexSchema.parse(entries), null, 2),
  });
}
