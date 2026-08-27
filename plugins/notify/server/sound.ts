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

export const SOUND_OPTIONS = [SOUND_OFF, SOUND_SYSTEM, ...SOUND_NAMES] as const;

/** Translate a setting into AppleScript's sound name. */
export function resolveSound(choice: string): string | null {
  if (choice === SOUND_SYSTEM) return "default";
  return SOUND_NAMES.find((name) => name === choice) ?? null;
}
