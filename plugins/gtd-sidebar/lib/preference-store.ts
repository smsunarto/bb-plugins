// The forked Thread list's layout preferences: organization, sort, row
// actions, and collapsed groups, kept in this plugin's own KV and pushed to
// every open window over realtime. Forked from bb's built-in Thread list
// (plugins/thread-list/server.ts at desktop-v0.48.1); the one-time import of
// bb's legacy `sidebar.*` UI preferences is left out.
import {
  cliCommand,
  defineRpcContract,
  PluginCliError,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  defaultPreferences,
  describePreference,
  getPreferenceDefault,
  isPreferenceKey,
  parsePreferenceValue,
  parseStoredPreferenceValue,
  PREFERENCE_KEYS,
  PREFERENCES_CHANGED_CHANNEL,
  preferenceDefinitions,
  type PreferenceKey,
  type PreferenceValue,
  type PreferenceValues,
} from "../shared/preferences.ts";

const PREFERENCE_KV_PREFIX = "preference:";

const preferenceKeySchema = z.enum(PREFERENCE_KEYS as [PreferenceKey, ...PreferenceKey[]]);

const preferenceValuesSchema = z.object(
  Object.fromEntries(PREFERENCE_KEYS.map((key) => [key, preferenceDefinitions[key].schema])) as {
    [Key in PreferenceKey]: (typeof preferenceDefinitions)[Key]["schema"];
  },
);

export const preferencesRpcContract = defineRpcContract({
  listPreferences: {
    input: z.null(),
    output: z.object({ preferences: preferenceValuesSchema }).strict(),
  },
  setPreference: {
    input: z
      .object({
        key: preferenceKeySchema,
        value: z.unknown(),
        origin: z.string().min(1).optional(),
      })
      .strict(),
    output: z.object({ key: preferenceKeySchema, value: z.unknown() }).strict(),
  },
  resetPreference: {
    input: z.object({ key: preferenceKeySchema }).strict(),
    output: z.object({ key: preferenceKeySchema, value: z.unknown() }).strict(),
  },
});

function kvKey(key: PreferenceKey): string {
  return `${PREFERENCE_KV_PREFIX}${key}`;
}

export function createPreferenceStore(bb: BbPluginApi) {
  async function read<Key extends PreferenceKey>(key: Key): Promise<PreferenceValue<Key>> {
    const stored = await bb.storage.kv.get<unknown>(kvKey(key));
    if (stored === undefined) return getPreferenceDefault(key);
    const parsed = parseStoredPreferenceValue(key, stored);
    if (parsed.success) return parsed.value;
    bb.log.warn(`stored preference ${key} is invalid (${parsed.message}); using the default`);
    return getPreferenceDefault(key);
  }

  async function readAll(): Promise<PreferenceValues> {
    const values = defaultPreferences();
    await Promise.all(
      PREFERENCE_KEYS.map(async (key) => {
        (values as Record<PreferenceKey, unknown>)[key] = await read(key);
      }),
    );
    return values;
  }

  async function write<Key extends PreferenceKey>(
    key: Key,
    value: unknown,
    origin: string | null,
  ): Promise<PreferenceValue<Key>> {
    const parsed = parsePreferenceValue(key, value);
    if (!parsed.success) {
      throw new PreferenceValidationError(key, parsed.message);
    }
    await bb.storage.kv.set(kvKey(key), parsed.value);
    bb.realtime.publish(PREFERENCES_CHANGED_CHANNEL, {
      key,
      value: parsed.value,
      origin,
    });
    return parsed.value;
  }

  async function reset<Key extends PreferenceKey>(key: Key): Promise<PreferenceValue<Key>> {
    await bb.storage.kv.delete(kvKey(key));
    const value = getPreferenceDefault(key);
    bb.realtime.publish(PREFERENCES_CHANGED_CHANNEL, {
      key,
      value,
      origin: null,
    });
    return value;
  }

  return { read, readAll, write, reset };
}

export class PreferenceValidationError extends Error {
  readonly key: PreferenceKey;
  readonly detail: string;

  constructor(key: PreferenceKey, detail: string) {
    super(`Invalid value for ${key}: ${detail}`);
    this.name = "PreferenceValidationError";
    this.key = key;
    this.detail = detail;
  }
}

function parseCliValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function requireCliPreferenceKey(raw: string): PreferenceKey {
  if (isPreferenceKey(raw)) return raw;
  throw new PluginCliError(`Unknown preference: ${raw}`, {
    code: "unknown_preference",
    hint: `Known preferences: ${PREFERENCE_KEYS.join(", ")}.`,
  });
}

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

/** The `prefs list|get|set|reset` subcommands of this plugin's CLI. */
export function preferenceCliCommands(store: ReturnType<typeof createPreferenceStore>) {
  return {
    "prefs list": cliCommand({
      summary: "List every preference and its current value",
      options: { json: JSON_OPTION },
      async run(input) {
        const values = await store.readAll();
        if (input.options.json) {
          return { exitCode: 0, stdout: JSON.stringify(values) };
        }
        return {
          exitCode: 0,
          stdout: PREFERENCE_KEYS.map(
            (key) => `${key}\t${JSON.stringify(values[key])}\t${describePreference(key)}`,
          ).join("\n"),
        };
      },
    }),
    "prefs get": cliCommand({
      summary: "Print one preference",
      positionals: [{ name: "key", description: "Preference name", required: true }],
      options: { json: JSON_OPTION },
      async run(input) {
        const key = requireCliPreferenceKey(input.positionals.key);
        const value = await store.read(key);
        return {
          exitCode: 0,
          stdout: input.options.json ? JSON.stringify({ key, value }) : JSON.stringify(value),
        };
      },
    }),
    "prefs set": cliCommand({
      summary: "Set one preference",
      positionals: [
        { name: "key", description: "Preference name", required: true },
        {
          name: "value",
          description: 'JSON value, e.g. \'"machine"\' or \'["pinned","threads"]\'',
          required: true,
        },
      ],
      options: { json: JSON_OPTION },
      async run(input) {
        const key = requireCliPreferenceKey(input.positionals.key);
        try {
          const value = await store.write(key, parseCliValue(input.positionals.value), null);
          return {
            exitCode: 0,
            stdout: input.options.json
              ? JSON.stringify({ key, value })
              : `${key} = ${JSON.stringify(value)}`,
          };
        } catch (error) {
          if (error instanceof PreferenceValidationError) {
            throw new PluginCliError(error.message, {
              code: "invalid_preference_value",
              hint: describePreference(key),
            });
          }
          throw error;
        }
      },
    }),
    "prefs reset": cliCommand({
      summary: "Restore one preference to its default",
      positionals: [{ name: "key", description: "Preference name", required: true }],
      options: { json: JSON_OPTION },
      async run(input) {
        const key = requireCliPreferenceKey(input.positionals.key);
        const value = await store.reset(key);
        return {
          exitCode: 0,
          stdout: input.options.json
            ? JSON.stringify({ key, value })
            : `${key} = ${JSON.stringify(value)}`,
        };
      },
    }),
  };
}
