import { z } from "zod";

/** The extension kind the bridge publishes its thread link under, as the
 *  declaration's `extensionKinds` key. bb prefixes the plugin id to form the
 *  wire value `AMP_THREAD_LINK_KIND` (src/bridge/kinds.ts). */
export const THREAD_LINK_EXTENSION_KIND = "thread-link";

/** Which Amp thread a bb thread maps to, and where it runs. A leaf shared by
 *  the declaration and the app, so the app bundle stays off server code. */
export const threadLinkStateSchema = z.object({
  ampThreadId: z.string().nullable(),
  executionTarget: z.enum(["local", "orb"]),
  syncCommand: z.string().nullable(),
});

export type AmpThreadLinkState = z.infer<typeof threadLinkStateSchema>;
