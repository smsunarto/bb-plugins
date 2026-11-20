// A Captain thread's sidebar icon, read from the Captain plugin's public keyed
// read `icons` (plugins/captain/src/contract/rpc.ts). The contract below mirrors
// only that method, and leaves each row unparsed, so a row in a shape this
// list doesn't know falls back to the globe instead of failing the read.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_useRpcKeyedQuery as useRpcKeyedQuery } from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";
import { z } from "zod";

export const CAPTAIN_PLUGIN_ID = "captain";
/** Captain's declared default glyph, `bb.branding.experimental_icons.captain`. */
export const CAPTAIN_DEFAULT_GLYPH = "captain/captain";

export const captainIconsContract = defineRpcContract({
  icons: {
    input: z.object({ keys: z.array(z.string().min(1).max(200)).max(500) }),
    output: z.record(z.string(), z.unknown()),
    // Captain's `iconTag`: its invalidations name these tags.
    keyTags: (key: string) => [`icon:${key}`],
  },
});

const captainIconSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }),
  z.object({ kind: z.literal("icon"), name: z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/u) }),
  z.object({
    kind: z.literal("image"),
    src: z.string().regex(/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/u),
  }),
]);
export type CaptainIcon = z.infer<typeof captainIconSchema>;

/** A row Captain sent, or null when it is missing or in a shape this list doesn't know. */
export function parseCaptainIcon(row: unknown): CaptainIcon | null {
  const parsed = captainIconSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

/**
 * The thread's Captain icon; null while it loads, when the thread is not a
 * live Captain, or when Captain is disabled or its read fails. Rows mounting
 * in one render share one batched read.
 */
export function useCaptainIcon(threadId: string): CaptainIcon | null {
  const keys = useMemo(() => [threadId], [threadId]);
  const rows = useRpcKeyedQuery({
    pluginId: CAPTAIN_PLUGIN_ID,
    contract: captainIconsContract,
    method: "icons",
    keys,
  });
  if (rows.error) return null;
  return parseCaptainIcon(rows.data?.[threadId]);
}
