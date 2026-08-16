import {
  chmodSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { compatibility } from "../src/compatibility.js";
import type { CommandResult } from "../src/index.js";

export const repositoryRoot = resolve(import.meta.dirname, "../../..");
// `executable()` returns the realpath, so this has to be one already. Linux
// merges `/bin` into `/usr/bin` through a symlink, where the literal `/bin/echo`
// came back as `/usr/bin/echo` and only macOS matched.
export const fakeBbCli = realpathSync("/bin/echo");

export function testEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, BB_CLI: fakeBbCli };
}

export function commandResult(
  overrides: Partial<CommandResult> = {},
): CommandResult {
  return {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

export function seedProjectExecutables(root: string): void {
  const directory = join(root, "node_modules/.bin");
  mkdirSync(directory, { recursive: true });
  for (const name of ["oxlint", "tsc"]) {
    const path = join(directory, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
}

/** Re-create a declaration bb vendored before 0.38, which now shadows the SDK package. */
export function writeVendoredDeclaration(root: string, content: string): void {
  mkdirSync(join(root, "types"), { recursive: true });
  writeFileSync(join(root, "types/bb-plugin-sdk.d.ts"), content);
}

export function makeOperationRequireInput(
  root: string,
  identity: string,
  kind: "query" | "command",
  exampleInput: unknown,
  risk: "safe" | "mutating" | "destructive" = "mutating",
): void {
  const [moduleName, operationName] = identity.split(".");
  if (!moduleName || !operationName) throw new Error(`invalid operation identity ${identity}`);
  writeFileSync(
    join(root, "plugin", "modules", moduleName, "operations", `${operationName}.ts`),
    [
      'import { defineOperation } from "@bb-kit/core/operations";',
      'import { z } from "zod";',
      "",
      "export default defineOperation({",
      `  kind: ${JSON.stringify(kind)},`,
      ...(kind === "command" ? [`  risk: ${JSON.stringify(risk)},`] : []),
      "  input: z.unknown(),",
      `  exampleInput: ${JSON.stringify(exampleInput)},`,
      "  output: z.object({}).strict(),",
      "});",
      "",
    ].join("\n"),
  );
}

export function writeBuildMetadata(root: string, app = false): void {
  const metadata = {
    sdkMajor: compatibility.pluginSdk.major,
    sdkVersion: compatibility.pluginSdk.version,
    artifactFormatVersion: compatibility.pluginSdk.artifactFormatVersion,
    pluginId: "example",
    pluginVersion: "0.1.0",
    builtWith: {
      bbVersion: compatibility.bbCliVersion,
      pluginSdkVersion: compatibility.pluginSdk.version,
    },
  };
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "dist/server.meta.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  if (app) {
    writeFileSync(
      join(root, "dist/app.meta.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  }
}
