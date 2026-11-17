/**
 * A role is one row: its Tasks preset, its contract file, and the skills its
 * threads get. Every role fact lives here, so adding a role is one entry.
 */

export const ROLES = ["plan", "implement", "review", "merge", "dream"] as const;
export type Role = (typeof ROLES)[number];

/** Roles Captain spawns itself and marks with `pluginMetadata { role }`. */
export const METADATA_ROLES: ReadonlySet<Role> = new Set(["merge", "dream"]);

/** The Tasks preset a role dispatches with. Presets are global and shared by every Captain. */
export type PresetSpec = {
  name: string;
  providerId: string;
  modelId: string;
  reasoningLevel: string;
  permissionMode: "accept-edits" | "auto" | "full";
  environmentKind: "project-default" | "new-worktree";
};

type RoleSpec = {
  label: string;
  /** `instructions/<contract>.md`, or null while the role's phase has not shipped. */
  contract: string | null;
  skills: readonly string[];
  /** Created by `bb captain new` when missing; null for roles Captain spawns itself. */
  preset: PresetSpec | null;
};

const CLAUDE_CODE = "claude-code";

// Model ids are unverified against the live claude-code catalog; Tasks accepts any
// string, so a wrong id surfaces only at dispatch (build step 3a).
export const ROLE_SPECS: Readonly<Record<Role, RoleSpec>> = {
  plan: {
    label: "Plan",
    contract: "roles/plan",
    skills: [],
    // Shared checkout; read-only by contract, since presets have no read-only mode.
    preset: {
      name: "Plan",
      providerId: CLAUDE_CODE,
      modelId: "claude-fable-5",
      reasoningLevel: "xhigh",
      permissionMode: "full",
      environmentKind: "project-default",
    },
  },
  implement: {
    label: "Implement",
    contract: "roles/implement",
    skills: [],
    preset: {
      name: "Implement",
      providerId: CLAUDE_CODE,
      modelId: "claude-opus-5-5",
      reasoningLevel: "high",
      permissionMode: "full",
      environmentKind: "new-worktree",
    },
  },
  review: {
    label: "Review",
    contract: "roles/review",
    skills: ["captain-review-lenses"],
    // Claude Code, because Review runs its lenses as subagents.
    preset: {
      name: "Review",
      providerId: CLAUDE_CODE,
      modelId: "claude-fable-5",
      reasoningLevel: "high",
      permissionMode: "full",
      environmentKind: "new-worktree",
    },
  },
  merge: { label: "Merge", contract: null, skills: [], preset: null },
  dream: { label: "Dream", contract: null, skills: [], preset: null },
};

/** Skills a Captain thread reads on demand. */
export const CAPTAIN_SKILLS: readonly string[] = [
  "captain-brief",
  "captain-review-loop",
  "captain-ship",
];

/** A role Captain starts through Tasks' dispatch: it has a preset. */
export function isDispatchable(role: Role): boolean {
  return ROLE_SPECS[role].preset !== null;
}

/** The role a Tasks preset name stands for, when it is one of the roles' presets. */
export function roleOfPreset(presetName: string): Role | null {
  const wanted = presetName.trim().toLowerCase();
  return ROLES.find((role) => ROLE_SPECS[role].preset?.name.toLowerCase() === wanted) ?? null;
}

/**
 * The owned verdict fields Captain defines in Tasks, one per verdict-writing
 * role. `defineField` at startup and `bb captain verdict` both read this table.
 * Triage is a field before it is a dispatchable role (Phase 5).
 */
export const VERDICT_FIELDS = {
  review: ["findings", "passed", "skipped"],
  triage: ["reproduced", "not-reproduced", "needs-info", "duplicate", "skipped"],
} as const satisfies Record<string, readonly string[]>;
export type VerdictField = keyof typeof VERDICT_FIELDS;

export function parseVerdictField(value: string): VerdictField | null {
  const lower = value.trim().toLowerCase();
  return Object.hasOwn(VERDICT_FIELDS, lower) ? (lower as VerdictField) : null;
}

/** Review verdicts that make a task ready to ship. */
export const SHIP_READY_REVIEWS: ReadonlySet<string> = new Set(["passed", "skipped"]);

/** Parse a role name from the CLI or metadata, case-insensitively. */
export function parseRole(value: unknown): Role | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return (ROLES as readonly string[]).includes(lower) ? (lower as Role) : null;
}

export const V1_PRESETS: readonly PresetSpec[] = ROLES.flatMap((role) => {
  const preset = ROLE_SPECS[role].preset;
  return preset === null ? [] : [preset];
});
