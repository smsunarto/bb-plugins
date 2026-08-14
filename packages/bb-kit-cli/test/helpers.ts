import {
  chmodSync,
  cpSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { CommandResult } from "../src/index.js";

export const repositoryRoot = resolve(import.meta.dirname, "../../..");
export const fakeBbCli = "/bin/echo";

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

export function seedCanonicalTypes(root: string): void {
  cpSync(
    join(repositoryRoot, "plugins/dotfiles/types"),
    join(root, "types"),
    { recursive: true },
  );
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
      'import { defineOperation } from "@smsunarto/bb-kit/operations";',
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
    sdkMajor: 0,
    sdkVersion: "0.4.1",
    artifactFormatVersion: 1,
    pluginId: "example",
    pluginVersion: "0.1.0",
    builtWith: {
      bbVersion: "0.37.0",
      pluginSdkVersion: "0.4.1",
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
