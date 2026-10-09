import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { COMPLETION_SOUND_PATH } from "../../shared/contract.ts";

/** Cursor's own turn-done sound, borrowed from a Cursor install rather than redistributed. */
export const CURSOR_COMPLETION_SOUND =
  "/Applications/Cursor.app/Contents/Resources/app/out/vs/platform/accessibilitySignal/browser/media/done1.mp3";
const READ_TIMEOUT_MS = 5_000;

/** The sound's bytes from the first connected host that has Cursor installed. */
async function readCursorSound(bb: BbPluginApi): Promise<Uint8Array<ArrayBuffer> | null> {
  const hosts = await bb.sdk.hosts.list();
  const reads = hosts
    .filter((host) => host.status === "connected")
    .map(async (host) => {
      const file = await bb.sdk.files.read({
        hostId: host.id,
        path: CURSOR_COMPLETION_SOUND,
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (file.contentEncoding !== "base64") throw new Error("expected binary audio");
      return new Uint8Array(Buffer.from(file.content, "base64"));
    });
  return Promise.any(reads).catch(() => null);
}

/**
 * Serve the completion sound to the browser, which plays it: the bb server may
 * run on another machine than the user's speakers. The bytes come from any
 * connected host with Cursor installed and stay in memory once found. A 404
 * tells the app to synthesize its own chime.
 */
export function registerCompletionSound(bb: BbPluginApi): void {
  let sound: Promise<Uint8Array<ArrayBuffer> | null> | null = null;
  bb.http.route("GET", COMPLETION_SOUND_PATH, async () => {
    sound ??= readCursorSound(bb).catch(() => null);
    const bytes = await sound;
    if (bytes === null) {
      sound = null;
      return new Response(null, { status: 404 });
    }
    return new Response(bytes, {
      headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=86400" },
    });
  });
}
