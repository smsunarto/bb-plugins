import { z } from "zod";

const STRING_MAX_LENGTH = 1_024;
const LIST_MAX_LENGTH = 10_000;

const listItemSchema = z.string().min(1).max(STRING_MAX_LENGTH);
const stringListSchema = z.array(listItemSchema).max(LIST_MAX_LENGTH);

export const organizationModeSchema = z.enum(["project", "chronological", "machine"]);
export type OrganizationMode = z.infer<typeof organizationModeSchema>;

// "arrival" is GTD's order: newest arrival on its shelf first, and a thread
// keeps its place while it stays on that shelf.
export const chronologicalSortSchema = z.enum(["arrival", "updated", "created", "alpha", "none"]);
export type ChronologicalSort = z.infer<typeof chronologicalSortSchema>;

export const sortDirectionSchema = z.enum(["default", "ascending", "descending"]);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

export const environmentGroupingSchema = z.union([z.literal("auto"), z.boolean()]);

export const THREAD_ROW_ACTION_LIMIT = 3;
const LEGACY_THREAD_ROW_ACTION_KEYS = {
  split: "bb--core/split",
  copyLink: "bb--core/copyLink",
  read: "bb--core/read",
  pin: "bb--core/pin",
  rename: "bb--core/rename",
  archive: "bb--core/archive",
} as const;
type LegacyThreadRowActionId = keyof typeof LEGACY_THREAD_ROW_ACTION_KEYS;
const LEGACY_CORE_KEY_PREFIX = "core/";

function isLegacyThreadRowActionId(value: string): value is LegacyThreadRowActionId {
  return Object.hasOwn(LEGACY_THREAD_ROW_ACTION_KEYS, value);
}

function migrateThreadRowActionKey(value: string): string {
  if (isLegacyThreadRowActionId(value)) {
    return LEGACY_THREAD_ROW_ACTION_KEYS[value];
  }
  return value.startsWith(LEGACY_CORE_KEY_PREFIX) ? `bb--${value}` : value;
}

export const threadRowActionKeySchema = z
  .string()
  .transform(migrateThreadRowActionKey)
  .pipe(
    z.string().regex(/^[^/\s]+\/[^/\s]+$/, {
      message: "Row actions are thread action keys: <owner>/<id>",
    }),
  );

export const SHELF_IDS = [
  "pinned",
  "nextAction",
  "waiting",
  "slopcop",
  "snoozed",
  "settled",
] as const;
export type ShelfId = (typeof SHELF_IDS)[number];

const shelfFoldsSchema = z.partialRecord(z.enum(SHELF_IDS), z.boolean());
const groupFoldsSchema = z
  .record(listItemSchema, z.boolean())
  .refine((value) => Object.keys(value).length <= LIST_MAX_LENGTH, {
    message: `At most ${LIST_MAX_LENGTH} folds`,
  });

function definePreference<Schema extends z.ZodTypeAny>(
  schema: Schema,
  defaultValue: z.infer<Schema>,
  description: string,
) {
  return { schema, defaultValue, description };
}

export const preferenceDefinitions = {
  showProviderIcons: definePreference(
    z.boolean(),
    true,
    "Show each thread's agent provider icon before its title.",
  ),
  showRowMetadata: definePreference(
    z.boolean(),
    false,
    "Show plugin metadata, such as pull request status, on each thread row.",
  ),
  organizationMode: definePreference(
    organizationModeSchema,
    "project",
    "How each shelf groups its threads: by project, by machine, or chronological (one list per shelf). A family follows its root thread's project or machine.",
  ),
  environmentGrouping: definePreference(
    environmentGroupingSchema,
    "auto",
    "Whether sibling threads sharing a worktree collapse into one row. auto groups them in every organization except chronological.",
  ),
  groupByReadStatus: definePreference(
    z.boolean(),
    false,
    "List threads that show an unread dot above the rest, keeping the selected sort within each group. The open thread keeps its place until another thread is opened.",
  ),
  chronologicalSort: definePreference(
    chronologicalSortSchema,
    "arrival",
    "Sort field within each shelf: arrival (newest arrival on the shelf first), updated, created, or alpha.",
  ),
  sortDirection: definePreference(
    sortDirectionSchema,
    "default",
    "Sort direction; default keeps the field's natural direction.",
  ),
  rowActions: definePreference(
    z
      .array(threadRowActionKeySchema)
      .max(LIST_MAX_LENGTH)
      .transform((value) => [...new Set(value)])
      .refine((value) => value.length <= THREAD_ROW_ACTION_LIMIT, {
        message: `Choose at most ${THREAD_ROW_ACTION_LIMIT} row actions`,
      }),
    ["gtd-sidebar/snooze", "gtd-sidebar/settle"],
    `Up to ${THREAD_ROW_ACTION_LIMIT} quick actions shown on a thread row's hover, left to right before its actions menu, as thread action keys: gtd-sidebar/settle, gtd-sidebar/snooze, gtd-sidebar/wake, gtd-sidebar/unsettle, bb--core/split, bb--core/copyLink, bb--core/read, bb--core/pin, bb--core/rename, bb--core/archive, or a plugin's <pluginId>/<actionId>. Bare legacy ids such as archive and core/<id> keys are accepted. An empty list shows only the menu.`,
  ),
  shelfFolds: definePreference(
    shelfFoldsSchema,
    {},
    "Shelves folded (true) or unfolded (false) against their default. SlopCop, Snoozed, and Settled start folded; the rest start open.",
  ),
  groupFolds: definePreference(
    groupFoldsSchema,
    {},
    "Project or machine groups folded (true) or unfolded (false) against their default, keyed '<shelf> <group key>'. Settled groups start folded.",
  ),
  expandedThreads: definePreference(
    stringListSchema,
    [],
    "Parent thread ids whose child threads show. Families start folded.",
  ),
  collapsedEnvironments: definePreference(
    stringListSchema,
    [],
    "Environment ids whose rows are collapsed.",
  ),
} as const;

export type PreferenceKey = keyof typeof preferenceDefinitions;
export const PREFERENCE_KEYS = Object.keys(preferenceDefinitions) as PreferenceKey[];

export type PreferenceValue<Key extends PreferenceKey> = z.infer<
  (typeof preferenceDefinitions)[Key]["schema"]
>;
export type PreferenceValues = {
  [Key in PreferenceKey]: PreferenceValue<Key>;
};

export function isPreferenceKey(value: string): value is PreferenceKey {
  return Object.hasOwn(preferenceDefinitions, value);
}

export function getPreferenceDefault<Key extends PreferenceKey>(key: Key): PreferenceValue<Key> {
  return preferenceDefinitions[key].defaultValue as PreferenceValue<Key>;
}

export function defaultPreferences(): PreferenceValues {
  return Object.fromEntries(
    PREFERENCE_KEYS.map((key) => [key, getPreferenceDefault(key)]),
  ) as PreferenceValues;
}

export type PreferenceParseResult<Key extends PreferenceKey> =
  | { success: true; value: PreferenceValue<Key> }
  | { success: false; message: string };

export function parsePreferenceValue<Key extends PreferenceKey>(
  key: Key,
  value: unknown,
): PreferenceParseResult<Key> {
  const schema: z.ZodTypeAny = preferenceDefinitions[key].schema;
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return { success: true, value: parsed.data as PreferenceValue<Key> };
  }
  return {
    success: false,
    message: parsed.error.issues.map((issue) => issue.message).join("; "),
  };
}

export function parseStoredPreferenceValue<Key extends PreferenceKey>(
  key: Key,
  value: unknown,
): PreferenceParseResult<Key> {
  return parsePreferenceValue(key, key === "rowActions" ? knownRowActions(value) : value);
}

function knownRowActions(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const known = value.flatMap((id) => {
    const parsed = threadRowActionKeySchema.safeParse(id);
    return parsed.success ? [parsed.data] : [];
  });
  return [...new Set(known)].slice(0, THREAD_ROW_ACTION_LIMIT);
}

export function describePreference(key: PreferenceKey): string {
  return preferenceDefinitions[key].description;
}

export const PREFERENCES_CHANGED_CHANNEL = "preferences";

export const preferencesChangedSignalSchema = z
  .object({
    key: z.enum(PREFERENCE_KEYS as [PreferenceKey, ...PreferenceKey[]]),
    value: z.unknown(),
    origin: z.string().nullable(),
  })
  .strict();
