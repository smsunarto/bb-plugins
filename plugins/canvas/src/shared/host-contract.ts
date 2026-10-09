import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * The host entry answers one question cheaply: is a file still the version
 * the server last read? Content never crosses this contract. Reads still go
 * through `bb.sdk.files.read`, which fences them inside the worktree or
 * thread storage.
 *
 * `stamp` is the file's identity and timestamps, `"absent"` when nothing is
 * there, and null when the host cannot vouch for it (a write too recent to
 * tell apart from the next one, or an unreadable path).
 */
export const canvasHostContract = defineRpcContract({
  stamp: {
    input: z.object({ path: z.string().min(1).max(4096) }).strict(),
    output: z.object({ stamp: z.string().nullable() }),
  },
});
