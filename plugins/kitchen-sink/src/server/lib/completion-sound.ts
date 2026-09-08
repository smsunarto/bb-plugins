import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const execFileAsync = promisify(execFile);
const CURSOR_COMPLETION_SOUND =
  "/Applications/Cursor.app/Contents/Resources/app/out/vs/platform/accessibilitySignal/browser/media/done1.mp3";

/** Uses the same local Cursor asset and macOS player as the retired Notify plugin. */
export async function playCursorCompletionSound(signal: AbortSignal): Promise<void> {
  if (process.platform !== "darwin") return;
  await execFileAsync("/usr/bin/afplay", [CURSOR_COMPLETION_SOUND], {
    timeout: 10_000,
    signal,
  });
}

export function registerCompletionSound(bb: BbPluginApi, play = playCursorCompletionSound): void {
  const controller = new AbortController();
  bb.onDispose(() => controller.abort());
  bb.events.on("thread.idle", async () => {
    try {
      await play(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        bb.log.warn(`Could not play Cursor completion sound: ${String(error)}`);
      }
    }
  });
}
