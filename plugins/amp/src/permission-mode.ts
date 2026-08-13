export type AmpPermissionMode = "default" | "bypass";

/** Map bb's resolved thread permission to the closest supported Amp mode. */
export function permissionModeFromBb(value: unknown): AmpPermissionMode | null {
  switch (value) {
    case "full":
      return "bypass";
    case "accept-edits":
    case "auto":
      return "default";
    default:
      return null;
  }
}
