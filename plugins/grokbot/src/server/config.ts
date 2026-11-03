import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Bot, GrokbotStatus } from "../shared/contract.ts";

/** Overrides the config path, e.g. for a dev instance pointed at a stub. */
export const CONFIG_PATH_ENV = "BB_GROKBOT_CONFIG";

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CONFIG_PATH_ENV]?.trim();
  return override ? override : join(homedir(), ".config", "bb-grokbot", "config.json");
}

const fileSchema = z.object({
  url: z
    .string()
    .trim()
    .refine((value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === "https:" || protocol === "http:";
      } catch {
        return false;
      }
    }, "url must be an http(s) URL")
    // fetch rejects URLs with credentials; say so instead of "Network error".
    .refine((value) => {
      try {
        const { username, password } = new URL(value);
        return username === "" && password === "";
      } catch {
        return true;
      }
    }, "url must not embed credentials; put the secret in key"),
  key: z
    .string()
    .trim()
    .min(1, "key must be a non-empty string")
    // fetch rejects header values outside visible ASCII; say so instead of "Network error".
    .regex(/^[\x21-\x7e]+$/, "key contains characters not allowed in an HTTP header"),
  bots: z
    .array(
      z.object({
        id: z.string().trim().min(1, "each bot needs an id"),
        name: z.string().trim().min(1).optional(),
      }),
    )
    .optional(),
});

/** The parsed file. Only the server holds this; the browser sees `GrokbotStatus`. */
export interface GrokbotConfig {
  readonly url: string;
  readonly key: string;
  readonly bots: readonly Bot[];
}

export type LoadedConfig =
  | { readonly state: "ready"; readonly configPath: string; readonly config: GrokbotConfig }
  | Exclude<GrokbotStatus, { state: "ready" }>;

/**
 * Read and validate the config file. Every failure names the path and the
 * fix, never the file's values. Group- or world-readable files are refused,
 * like ssh does with private keys: the key is a credential.
 */
export async function loadConfig(configPath = defaultConfigPath()): Promise<LoadedConfig> {
  let raw: string;
  try {
    const info = await stat(configPath);
    if (!info.isFile()) {
      return { state: "invalid", configPath, reason: `${configPath} is not a file.` };
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      const mode = (info.mode & 0o777).toString(8).padStart(3, "0");
      return {
        state: "insecure",
        configPath,
        reason: `${configPath} has mode ${mode}; run chmod 600 "${configPath}".`,
      };
    }
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return { state: "missing", configPath, reason: `No config file at ${configPath}.` };
    }
    return { state: "invalid", configPath, reason: `Cannot read ${configPath}.` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { state: "invalid", configPath, reason: `${configPath} is not valid JSON.` };
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return {
      state: "invalid",
      configPath,
      reason: `${configPath}: ${where}${issue?.message ?? "invalid config"}.`,
    };
  }
  const seen = new Set<string>();
  const bots: Bot[] = [];
  for (const bot of parsed.data.bots ?? []) {
    if (seen.has(bot.id)) continue;
    seen.add(bot.id);
    bots.push({ id: bot.id, name: bot.name ?? bot.id });
  }
  return {
    state: "ready",
    configPath,
    config: { url: parsed.data.url, key: parsed.data.key, bots },
  };
}

/** The browser-safe view of a loaded config. */
export function publicStatus(loaded: LoadedConfig): GrokbotStatus {
  if (loaded.state !== "ready") return loaded;
  return { state: "ready", configPath: loaded.configPath, bots: [...loaded.config.bots] };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
