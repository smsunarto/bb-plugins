import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The only module that calls `push-notifications`, with a deadline per call. */

const PUSH_PLUGIN_ID = "push-notifications";
const PUSH_DEADLINE_MS = 10_000;

/**
 * `input-only` pushes interactions and errors, never the silent wakes of every
 * turn end. Set on each thread explicitly, because a parent's level only quiets
 * its children. Returns a warning instead of failing the command.
 */
export async function setPushLevel(
  bb: Pick<BbPluginApi, "sdk">,
  threadId: string,
): Promise<string | null> {
  try {
    await bb.sdk.plugins.callRpc({
      pluginId: PUSH_PLUGIN_ID,
      method: "threadNotifications.set",
      input: { threadId, level: "input-only" },
      outputSchema: z.object({ own: z.string() }),
      signal: AbortSignal.timeout(PUSH_DEADLINE_MS),
    });
    return null;
  } catch (error) {
    return `push level of ${threadId} not set to input-only: ${(error as Error).message}`;
  }
}

/** One push to every enabled channel; a click opens `threadId`. Returns a warning on failure. */
export async function sendPush(
  bb: Pick<BbPluginApi, "sdk">,
  push: { title: string; body: string; threadId: string },
): Promise<string | null> {
  try {
    const { channels } = await bb.sdk.plugins.callRpc({
      pluginId: PUSH_PLUGIN_ID,
      method: "notifications.send",
      input: push,
      outputSchema: z.object({ ok: z.literal(true), channels: z.array(z.string()) }),
      signal: AbortSignal.timeout(PUSH_DEADLINE_MS),
    });
    return channels.length === 0 ? "push reached no channel" : null;
  } catch (error) {
    return `push not sent: ${(error as Error).message}`;
  }
}
