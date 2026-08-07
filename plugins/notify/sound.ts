// Notification sound.
//
// The web Notification API has one sound control: `silent`. It cannot name a
// tone. So a named sound is played alongside a silenced notification, by the
// one utility guaranteed to be on every macOS box.
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";

const SOUND_DIR = "/System/Library/Sounds";

/** The macOS system sounds, plus the two non-tone choices. */
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

export const SOUND_OPTIONS = [
  SOUND_OFF,
  SOUND_SYSTEM,
  ...SOUND_NAMES,
] as const;

export type SoundChoice = (typeof SOUND_OPTIONS)[number];

/**
 * How a choice is carried out. `silent` is what the window passes to the
 * Notification; `play` is a system sound to sound alongside it.
 *
 * A named tone silences the notification so macOS does not stack its own
 * default underneath the chosen one.
 */
export function resolveSound(choice: string): {
  silent: boolean;
  play: string | null;
} {
  if (choice === SOUND_SYSTEM) return { silent: false, play: null };
  const named = SOUND_NAMES.find((name) => name === choice);
  if (named === undefined) return { silent: true, play: null };
  return { silent: true, play: named };
}

/**
 * Play a system sound. The name is matched against the known list rather than
 * escaped, so no caller string ever reaches the filesystem.
 */
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
    execFile("afplay", [file], { timeout: 10_000 }, () => resolve());
  });
}
