import type { ComposerSelection } from "@get-bb/plugin-sdk/app";

export type PermissionMode = NonNullable<ComposerSelection["permissionMode"]>;

export interface PermissionModeOption {
  value: PermissionMode;
  label: string;
  /** The trigger's label once the composer is narrow. */
  compactLabel: string;
  icon: string;
  tone?: "warning";
  disabled?: boolean;
}

// BB's own options (client-core's PERMISSION_MODE_OPTIONS, app's PERMISSION_MODE_ICONS and
// compact labels), copied so this picker reads the same as BB's. Keep them in step with BB.
const OPTIONS: readonly PermissionModeOption[] = [
  {
    value: "accept-edits",
    label: "Accept Edits",
    compactLabel: "Edits",
    icon: "FolderEdit",
  },
  {
    value: "auto",
    label: "Approve for me",
    compactLabel: "Auto",
    icon: "SecurityCheck",
  },
  {
    value: "full",
    label: "Full Access",
    compactLabel: "Full",
    icon: "SquareUnlock02",
    tone: "warning",
  },
];

/** BB's reason for a mode above the machine's limit, shown under its label. */
export const CEILING_REASON =
  "Above the selected machine's permission limit. Change it in Settings → Machines.";

const RANK: Record<PermissionMode, number> = { "accept-edits": 0, auto: 1, full: 2 };

/** The mode just below `mode`, or null for the lowest. */
export function permissionModeBelow(mode: PermissionMode): PermissionMode | null {
  const rank = RANK[mode] - 1;
  return (Object.keys(RANK) as PermissionMode[]).find((other) => RANK[other] === rank) ?? null;
}

export function isPermissionModeAbove(mode: PermissionMode, other: PermissionMode): boolean {
  return RANK[mode] > RANK[other];
}

/** The modes a provider offers that the machine's ceiling allows. */
export function allowedPermissionModes(
  modes: readonly PermissionMode[],
  ceiling: PermissionMode,
): PermissionMode[] {
  return modes.filter((mode) => RANK[mode] <= RANK[ceiling]);
}

/**
 * The mode BB's picker settles on for `value`: the value itself when allowed, else Approve
 * for me, else Full Access, else the first allowed mode (BB's resolvePermissionModeSelection).
 */
export function resolvePermissionMode(
  value: PermissionMode,
  modes: readonly PermissionMode[],
  ceiling: PermissionMode,
): PermissionMode {
  const allowed = allowedPermissionModes(modes, ceiling);
  const candidates = allowed.length > 0 ? allowed : modes;
  if (candidates.includes(value)) return value;
  if (candidates.includes("auto")) return "auto";
  if (candidates.includes("full")) return "full";
  return candidates[0] ?? "auto";
}

/** The provider's modes in BB's order, those above the ceiling disabled. */
export function permissionModeOptions(
  modes: readonly PermissionMode[],
  ceiling: PermissionMode,
): PermissionModeOption[] {
  const options: PermissionModeOption[] = [];
  for (const option of OPTIONS) {
    if (!modes.includes(option.value)) continue;
    options.push(RANK[option.value] > RANK[ceiling] ? { ...option, disabled: true } : option);
  }
  return options;
}

export function permissionModeOption(value: PermissionMode): PermissionModeOption | undefined {
  return OPTIONS.find((option) => option.value === value);
}
