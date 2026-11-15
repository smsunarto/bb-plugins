import type { Orientation } from "./live.ts";

/**
 * What `bb sauce start` applies for a project when the command names nothing else.
 * A landscape game and a portrait app share the one device, so the default belongs
 * to the project, not to the plugin.
 */
export type ProjectDefaults = {
  /** How the device is held when a session starts; null leaves it as Sauce starts it (portrait). */
  orientation: Orientation | null;
};

export const NO_DEFAULTS: ProjectDefaults = { orientation: null };

export interface DefaultsStore {
  read(projectId: string): ProjectDefaults;
  write(projectId: string, defaults: ProjectDefaults): void;
}

export function parseOrientation(value: unknown): Orientation | null {
  return value === "portrait" || value === "landscape" ? value : null;
}
