import { randomBytes } from "node:crypto";
import { readTextOr, writeAtomic } from "./fsx.ts";

export function generateKey(): string {
  return randomBytes(32).toString("base64url");
}

/** Settings have no programmatic write in the plugin SDK, so generated secrets
    live in 0600 files under the plugin data dir; the secret setting (when set)
    overrides the file. */
export function loadOrCreateKey(path: string): string {
  const existing = readTextOr(path)?.trim();
  if (existing) return existing;
  const key = generateKey();
  writeAtomic(path, `${key}\n`, 0o600);
  return key;
}
