// Everything the user sets that is not a key. BB draws declared settings as one
// flat card above the plugin's own sections, with no way to group them or to
// leave one out, so only the keys and the choice between them are declared.
// The rest lives here, in the plugin's own storage, where the settings page can
// put each next to what it governs. `bb magic-compose preferences` reads and
// writes them from a shell. Shared by the server and the app.
import { z } from "zod";

/** Kept here, not with the Jev client, so the app can share this file without the client's Node code. */
export const DEFAULT_JEV_MODELS = {
  vercel: "typesafe-ai/jev",
  openrouter: "typesafe/jev-1.13",
} as const;

export const PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;

export const INSTRUCTIONS_MAX = 4_000;
const instructionsSchema = z.string().max(INSTRUCTIONS_MAX);
const jevModelSchema = z.string().trim().min(1).max(200);

const maySetSchema = z
  .object({
    project: z.boolean(),
    placement: z.boolean(),
    model: z.boolean(),
    effort: z.boolean(),
  })
  .strict();

// No field here has a default. A default would be filled into a patch that does
// not mention the field, and saving one preference would reset all the others.
const fields = {
  generalInstructions: instructionsSchema,
  modelInstructions: instructionsSchema,
  projectInstructions: instructionsSchema,
  machineInstructions: instructionsSchema,
  environmentInstructions: instructionsSchema,
  /** For threads `bb magic-compose spawn` starts. In the composer the picker is the user's. */
  permissionMode: z.enum(PERMISSION_MODES),
  jevModel: jevModelSchema,
  openRouterJevModel: jevModelSchema,
  /** Which of the composer's pickers Magic Compose may set. Effort is chosen per model, so it needs `model`. */
  maySet: maySetSchema,
  /** Hold the composer's send until the pickers match the draft. */
  holdSend: z.boolean(),
  /** Ask Jev as the draft is typed, or only once typing pauses. */
  pace: z.enum(["typing", "pause"]),
};

export const preferencesSchema = z.object(fields).strict();
export type Preferences = z.infer<typeof preferencesSchema>;
export type MaySet = Preferences["maySet"];
export type Pace = Preferences["pace"];

/** Some of the preferences, and only those: what a save sends. */
export const preferencesPatchSchema = z.object(fields).partial().strict();

export const DEFAULT_PREFERENCES: Preferences = {
  generalInstructions: "",
  modelInstructions: "",
  projectInstructions: "",
  machineInstructions: "",
  environmentInstructions: "",
  permissionMode: "auto",
  jevModel: DEFAULT_JEV_MODELS.vercel,
  openRouterJevModel: DEFAULT_JEV_MODELS.openrouter,
  maySet: { project: true, placement: true, model: true, effort: true },
  holdSend: true,
  pace: "typing",
};

/**
 * What is stored, read as preferences. A preference added since it was stored
 * takes its default; anything unreadable gives the defaults.
 */
export function readStoredPreferences(stored: unknown): Preferences {
  if (typeof stored !== "object" || stored === null) return DEFAULT_PREFERENCES;
  const record = stored as Record<string, unknown>;
  const maySet = typeof record.maySet === "object" && record.maySet !== null ? record.maySet : {};
  const parsed = preferencesSchema.safeParse({
    ...DEFAULT_PREFERENCES,
    ...record,
    maySet: { ...DEFAULT_PREFERENCES.maySet, ...maySet },
  });
  return parsed.success ? parsed.data : DEFAULT_PREFERENCES;
}
