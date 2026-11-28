import { z } from "zod";

/** Stable provider id. Threads persist it, so it never changes. */
export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

/** Runtime plugin id derived from `@smsunarto/bb-plugin-antigravity`. */
export const ANTIGRAVITY_PLUGIN_ID = "antigravity";

/** Custom ACP dialect id registered in `src/host/dialect.ts`. */
export const ANTIGRAVITY_DIALECT_ID = "antigravity";

/** Non-secret settings passed from the server declaration into provider options. */
export const antigravitySettingsSchema = z.object({
  sandboxEnabled: z.boolean().default(false),
  disableTelemetry: z.boolean().default(false),
  defaultAgent: z.string().default(""),
  executablePath: z.string().default(""),
});

export type AntigravitySettings = z.infer<typeof antigravitySettingsSchema>;

export function parseAntigravitySettings(raw: unknown): AntigravitySettings {
  const parsed = antigravitySettingsSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : {
        sandboxEnabled: false,
        disableTelemetry: false,
        defaultAgent: "",
        executablePath: "",
      };
}
