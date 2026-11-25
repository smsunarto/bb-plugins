// A local mirror of the Captain plugin's contract (plugins/captain/src/contract/rpc.ts),
// only the methods the sidebar calls. The app reaches them through the SDK by
// plugin id, and only once bb lists Captain as running (hooks/use-captain.ts),
// so the sidebar works the same with Captain absent. bb derives a read's tags
// from this copy in the browser, so the tag strings must match Captain's.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const CAPTAIN_PLUGIN_ID = "captain";
/** A Captain's name is one line of at most this many characters. */
export const CAPTAIN_NAME_MAX = 80;

const threadId = z.string().regex(/^thr_[A-Za-z0-9_-]+$/u);

export const captainContract = defineRpcContract({
  captains: {
    input: z.object({}).strict(),
    output: z.object({ ids: z.array(threadId) }).strict(),
    tags: () => ["captains"],
  },
  needsYou: {
    input: z.object({ keys: z.array(z.string().min(1).max(200)).max(500) }).strict(),
    output: z.record(z.string(), z.number().int().nonnegative()),
    keyTags: (captainId) => [`asks:${captainId}`, `crew:${captainId}`],
  },
  newCaptain: {
    input: z
      .object({
        name: z.string().max(200),
        repos: z.array(z.string().min(1).max(200)).max(50),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z
        .object({
          ok: z.literal(true),
          threadId,
          state: z.enum(["started", "exists"]),
          warnings: z.array(z.string()),
        })
        .strict(),
      z
        .object({
          ok: z.literal(false),
          blockers: z.array(z.object({ reason: z.string(), fix: z.string() }).strict()),
        })
        .strict(),
    ]),
  },
});
