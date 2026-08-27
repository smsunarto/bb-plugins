import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";

const SOUND_DIR = "/System/Library/Sounds";

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

export const SOUND_OPTIONS = [SOUND_OFF, SOUND_SYSTEM, ...SOUND_NAMES] as const;

export function resolveSound(choice: string): { silent: boolean; play: string | null } {
  if (choice === SOUND_SYSTEM) return { silent: false, play: null };
  const named = SOUND_NAMES.find((name) => name === choice);
  if (named === undefined) return { silent: true, play: null };
  return { silent: true, play: named };
}

export async function playSound(name: string): Promise<void> {
  const known = SOUND_NAMES.find((candidate) => candidate === name);
  if (known === undefined) return;
  const file = `${SOUND_DIR}/${known}.aiff`;
  try {
    await access(file, constants.R_OK);
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    execFile("/usr/bin/afplay", [file], { timeout: 10_000 }, () => resolve());
  });
}
