import type { CoreState } from "./core-process.ts";

export function canStopService(state: CoreState, loaded: boolean): boolean {
  if (state === "not-installed") return false;
  return state !== "stopped" || loaded;
}
