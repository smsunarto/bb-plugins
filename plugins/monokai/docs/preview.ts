/**
 * A sample for eyeballing the bb Monokai code theme. Nothing imports it; it
 * exists to be looked at, in the diff viewer or the file preview.
 *
 * What each hue should land on, measured against this file:
 *   grey    #beb899  commentary (this block)
 *   pink    #fe5d86  machinery — import, from, export, and operators
 *   cyan    #51dae9  structure — storage keywords and type names, null among them
 *   green   #9ddd54  callables — function and method names, declared or called
 *   yellow  #f7d05c  strings, and the body of a regex
 *   purple  #a895fe  constants — numbers, booleans, regex character classes
 *   orange  #ff8342  parameters, type parameters, and their annotations
 *   white   #e3e3dd  everything else — variables, enum members, punctuation
 *
 * A diff has no language server behind it, so this is the TextMate layer alone.
 * An editor colours some of these from semantic tokens instead and will differ.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const RETRY_LIMIT = 3;
const BACKOFF_MS = 250.75;
const STRICT_JSON = true;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.]+))?$/i;

export enum Appearance {
  Dark = "dark",
  Light = "light",
}

export interface ThemeSource {
  readonly id: string;
  readonly appearance: Appearance;
  readonly tokenCount: number;
  readonly fallback?: string | null;
}

type Resolver<T> = (source: ThemeSource, attempt: number) => Promise<T>;

/** Reads a theme off disk, retrying a transient failure a few times. */
export async function loadTheme(path: string, retries = RETRY_LIMIT): Promise<ThemeSource> {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      if (!STRICT_JSON) return { id: path, appearance: Appearance.Light, tokenCount: 0 };
      const raw = await readFile(fileURLToPath(path), "utf8");
      const { name, tokenColors } = JSON.parse(raw) as {
        name: string;
        tokenColors: unknown[];
      };
      return { id: name, appearance: Appearance.Dark, tokenCount: tokenColors.length };
    } catch (cause) {
      if (attempt === retries) {
        throw new Error(`gave up on ${path} after ${attempt} tries`, { cause });
      }
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * attempt));
    }
  }
  throw new Error("unreachable");
}

export abstract class Registry<T extends ThemeSource> {
  protected readonly entries = new Map<string, T>();

  constructor(private readonly label: string) {}

  abstract resolve(id: string): Resolver<T>;

  register(entry: T): this {
    if (this.entries.has(entry.id)) {
      console.warn(`${this.label}: ${entry.id} is already registered — replacing it`);
    }
    this.entries.set(entry.id, entry);
    return this;
  }

  describe(): string {
    const parts = [...this.entries.values()]
      .filter((entry) => entry.tokenCount > 0)
      .map(({ id, tokenCount }) => `${id} (${tokenCount})`);
    return parts.length === 0 ? "empty" : parts.join(", ");
  }
}

const version = "0.38.0";
const parsed = SEMVER.exec(version)?.slice(1, 4).map(Number) ?? [0, 0, 0];
const supported = parsed[0] === 0 && parsed[1] >= 38;

console.log(`bb ${version} — code theme ${supported ? "supported" : "unavailable"}`);
