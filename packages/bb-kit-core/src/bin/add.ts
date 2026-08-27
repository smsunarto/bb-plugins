import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BinResult } from "./shared.ts";
import {
  UNIT_NAME_PATTERN,
  camelName,
  compositionRootFromPkg,
  relativeImport,
  unitDir,
} from "./shared.ts";
import { derivePluginID } from "./derive-plugin-id.ts";
import { toolName } from "../tools/tools.ts";

/**
 * `bb-kit add <query|mutation|command|tool> <name>` (§8): write one unit file
 * and its sibling test, then PRINT the wiring lines — add never edits
 * the composition root (ADR-0009). The name is the kebab-case filename; the value
 * export is its camelization, so `check` rule 1 holds by construction.
 * Printed import specifiers are relative to `bb.server`.
 */

export type AddOptions = { cwd: string };

const ADD_KINDS = ["query", "mutation", "command", "tool"] as const;
export type AddKind = (typeof ADD_KINDS)[number];

function queryTemplate(exportName: string): string {
  return [
    'import { defineQuery } from "@bb-kit/core/rpc";',
    'import { z } from "zod";',
    "",
    `export const ${exportName} = defineQuery({`,
    "  output: z.object({ ok: z.boolean() }),",
    "  async execute(_ctx) {",
    "    return { ok: true };",
    "  },",
    "});",
    "",
  ].join("\n");
}

function mutationTemplate(exportName: string): string {
  return [
    'import { defineMutation } from "@bb-kit/core/rpc";',
    'import { z } from "zod";',
    "",
    `export const ${exportName} = defineMutation({`,
    "  input: z.object({ value: z.string() }),",
    "  output: z.object({ ok: z.boolean() }),",
    "  async execute(_ctx, { value: _value }) {",
    "    return { ok: true };",
    "  },",
    "});",
    "",
  ].join("\n");
}

function procedureTestTemplate(name: string, exportName: string, kind: AddKind): string {
  const call =
    kind === "mutation"
      ? `${exportName}.execute(stubHostContext(), { value: "x" })`
      : `${exportName}.execute(stubHostContext())`;
  return [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { stubHostContext } from "@bb-kit/core/testing";',
    `import { ${exportName} } from "./${name}.ts";`,
    "",
    `test("${name} answers", async () => {`,
    `  assert.deepEqual(await ${call}, { ok: true });`,
    "});",
    "",
  ].join("\n");
}

function commandTemplate(name: string, exportName: string): string {
  return [
    'import { defineCommand } from "@bb-kit/core/command";',
    "",
    `export const ${exportName} = defineCommand({`,
    `  summary: "TODO: describe ${name}",`,
    "  async execute(_ctx) {",
    `    return { exitCode: 0, stdout: "${name}: TODO\\n" };`,
    "  },",
    "});",
    "",
  ].join("\n");
}

function commandTestTemplate(name: string, exportName: string): string {
  return [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { stubHostContext } from "@bb-kit/core/testing";',
    `import { ${exportName} } from "./${name}.ts";`,
    "",
    `test("${name} runs", async () => {`,
    `  const result = await ${exportName}.execute(stubHostContext());`,
    "  assert.equal(result.exitCode, 0);",
    "});",
    "",
  ].join("\n");
}

function toolTemplate(name: string, exportName: string): string {
  return [
    'import { defineTool, type ToolContext } from "@bb-kit/core/tools";',
    'import { z } from "zod";',
    'import type { Context } from "@bb-kit/core/plugin";',
    "",
    `export const ${exportName} = defineTool({`,
    `  description: "TODO: describe ${name} for the agent",`,
    "  parameters: z.object({ value: z.string() }),",
    `  execute: (_ctx: ToolContext<Context>, _input) => "${name}: TODO",`,
    "});",
    "",
  ].join("\n");
}

function toolTestTemplate(name: string, exportName: string): string {
  return [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { stubHostContext } from "@bb-kit/core/testing";',
    `import { ${exportName} } from "./${name}.ts";`,
    "",
    `test("${name} executes", async () => {`,
    "  const ctx = {",
    "    ...stubHostContext(),",
    '    tool: { threadId: "t", projectId: "p", signal: new AbortController().signal },',
    "  };",
    `  assert.equal(await ${exportName}.execute(ctx, { value: "x" }), "${name}: TODO");`,
    "});",
    "",
  ].join("\n");
}

export function runAdd(kind: string, name: string, options: AddOptions): BinResult {
  if (!(ADD_KINDS as readonly string[]).includes(kind)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `unknown kind "${kind}" — expected query, mutation, command, or tool\n`,
    };
  }
  if (!UNIT_NAME_PATTERN.test(name)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `"${name}" is not a kebab-case unit name (expected ${UNIT_NAME_PATTERN})\n`,
    };
  }

  const packageJsonPath = join(options.cwd, "package.json");
  if (!existsSync(packageJsonPath)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "no package.json here — run add at the plugin root\n",
    };
  }

  const isProcedure = kind === "query" || kind === "mutation";
  const isTool = kind === "tool";
  const publicName = isProcedure ? camelName(name) : undefined;

  let compositionRoot = "server/server.ts";
  let packageName: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
    compositionRoot = compositionRootFromPkg(pkg) ?? compositionRoot;
    const rawName = pkg["name"];
    packageName = typeof rawName === "string" ? rawName : undefined;
  } catch {
    // Unparseable JSON still writes beside the scaffold default.
  }

  const dir = unitDir(compositionRoot, isProcedure ? "rpc" : isTool ? "tools" : "command");
  const unitRelative = `${dir}/${name}.ts`;
  const testRelative = `${dir}/${name}.test.ts`;
  for (const relative of [unitRelative, testRelative]) {
    if (existsSync(join(options.cwd, relative))) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `${relative} already exists — add never overwrites (ADR-0009)\n`,
      };
    }
  }

  const exportName = camelName(name);
  const unitContent =
    kind === "query"
      ? queryTemplate(exportName)
      : kind === "mutation"
        ? mutationTemplate(exportName)
        : isTool
          ? toolTemplate(name, exportName)
          : commandTemplate(name, exportName);
  const testContent = isProcedure
    ? procedureTestTemplate(name, exportName, kind as AddKind)
    : isTool
      ? toolTestTemplate(name, exportName)
      : commandTestTemplate(name, exportName);

  mkdirSync(join(options.cwd, dir), { recursive: true });
  writeFileSync(join(options.cwd, unitRelative), unitContent);
  writeFileSync(join(options.cwd, testRelative), testContent);

  const importSpecifier = relativeImport(compositionRoot, unitRelative);

  const lines = [`created ${unitRelative}`, `created ${testRelative}`, ""];
  lines.push(`wire it in ${compositionRoot} — the import:`, "");
  lines.push(`  import { ${exportName} } from "${importSpecifier}";`, "");
  if (isProcedure) {
    lines.push("and the rpc entry:", "", `  ${exportName},`, "");
    lines.push(`name: ${publicName}`);
  } else if (isTool) {
    const key = name.replaceAll("-", "_");
    const entry = key === exportName ? `${exportName},` : `${key}: ${exportName},`;
    lines.push("and the agents.tools entry:", "", `  ${entry}`, "");
    lines.push(`(the agents.tools key must stay "${key}" — check rule 1 pins it to the filename)`);
    if (packageName !== undefined) {
      try {
        lines.push(`name: ${toolName(derivePluginID(packageName), key)}`);
      } catch {
        // An underivable package name — check rule 2 reports it.
      }
    }
  } else {
    const entry = name === exportName ? `${exportName},` : `"${name}": ${exportName},`;
    lines.push("and the command entry:", "", `  ${entry}`, "");
    lines.push(`(the commands key must stay "${name}" — check rule 1 pins it to the filename)`);
  }
  return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}
