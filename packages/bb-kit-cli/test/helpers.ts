import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommandResult } from "../src/index.js";

export const repositoryRoot = resolve(import.meta.dirname, "../../..");
// `executable()` returns the realpath, so this has to be one already. Linux
// merges `/bin` into `/usr/bin` through a symlink, where the literal `/bin/echo`
// came back as `/usr/bin/echo` and only macOS matched.
export const fakeBbCli = realpathSync("/bin/echo");

export function testEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, BB_CLI: fakeBbCli };
}

export function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

/** Re-create a declaration bb vendored before 0.38, which now shadows the SDK package. */
export function writeVendoredDeclaration(root: string, content: string): void {
  mkdirSync(join(root, "types"), { recursive: true });
  writeFileSync(join(root, "types/bb-plugin-sdk.d.ts"), content);
}
