import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";

const SOUND_DIR = "/System/Library/Sounds";
const CURSOR_AGENT_FINISH_SOUND =
  "/Applications/Cursor.app/Contents/Resources/app/out/vs/platform/accessibilitySignal/browser/media/done1.mp3";

export const SOUND_NAMES = [
  "Basso",
  "Blow",
  "Bottle",
  "Frog",
  "Funk",
  "Glass",
  "Hero",
  "Morse",
  "Ping",
  "Pop",
  "Purr",
  "Sosumi",
  "Submarine",
  "Tink",
] as const;

export const SOUND_OFF = "off";
export const SOUND_SYSTEM = "system default";
export const SOUND_CURSOR = "Cursor completion";

export const SOUND_OPTIONS = [SOUND_OFF, SOUND_SYSTEM, SOUND_CURSOR, ...SOUND_NAMES] as const;

export function resolveSound(choice: string): { silent: boolean; play: string | null } {
  if (choice === SOUND_SYSTEM) return { silent: false, play: null };
  if (choice === SOUND_CURSOR) return { silent: true, play: SOUND_CURSOR };
  const named = SOUND_NAMES.find((name) => name === choice);
  if (named === undefined) return { silent: true, play: null };
  return { silent: true, play: named };
}

export function resolveSoundPath(name: string): string | null {
  if (name === SOUND_CURSOR) return CURSOR_AGENT_FINISH_SOUND;
  const known = SOUND_NAMES.find((candidate) => candidate === name);
  return known === undefined ? null : `${SOUND_DIR}/${known}.aiff`;
}

export async function playSound(name: string): Promise<void> {
  const file = resolveSoundPath(name);
  if (file === null) return;
  try {
    await access(file, constants.R_OK);
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    execFile("/usr/bin/afplay", [file], { timeout: 10_000 }, () => resolve());
  });
}
