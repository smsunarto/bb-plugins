import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BinResult } from "./shared.ts";
import { UNIT_NAME_PATTERN, camelName } from "./shared.ts";
import { derivePluginID } from "./derive-plugin-id.ts";
import { wireName } from "../rpc/wire-name.ts";

/**
 * `bb-kit add <query|mutation|command> <name>` (§7): write one unit file
 * and its sibling test, then PRINT the wiring lines — add never edits
 * server.ts (ADR-0009). The name is the kebab-case filename; the value
 * export is its camelization, so `check` rule 1 holds by construction.
 */

export type AddOptions = { cwd: string };

const ADD_KINDS = ["query", "mutation", "command"] as const;
export type AddKind = (typeof ADD_KINDS)[number];

function queryTemplate(exportName: string): string {
  return [
    'import { defineQuery } from "@bb-kit/core/rpc";',
    'import { z } from "zod";',
    'import type { Context } from "../server/context.ts";',
    "",
    `export const ${exportName} = defineQuery({`,
    "  output: z.object({ ok: z.boolean() }),",
    "  handler: (_context: Context) => ({ ok: true }),",
    "});",
    "",
  ].join("\n");
}

function mutationTemplate(exportName: string): string {
  return [
    'import { defineMutation } from "@bb-kit/core/rpc";',
    'import { z } from "zod";',
    'import type { Context } from "../server/context.ts";',
    "",
    `export const ${exportName} = defineMutation({`,
    "  input: z.object({ value: z.string() }),",
    "  output: z.object({ ok: z.boolean() }),",
    "  handler: (_context: Context, _input) => ({ ok: true }),",
    "});",
    "",
  ].join("\n");
}

function procedureTestTemplate(name: string, exportName: string, kind: AddKind): string {
  const call =
    kind === "mutation"
      ? `${exportName}.handler({} as Context, { value: "x" })`
      : `${exportName}.handler({} as Context)`;
  return [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import type { Context } from "../server/context.ts";',
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
    'import { defineCommand } from "@bb-kit/core/cli";',
    'import type { Client } from "../server.ts";',
    "",
    `export const ${exportName} = defineCommand({`,
    `  summary: "TODO: describe ${name}",`,
    "  run: async (_client: Client) => {",
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
    'import { invokeCLI } from "@bb-kit/core/cli";',
    'import { stubClient } from "@bb-kit/core/testing";',
    'import type { Client } from "../server.ts";',
    `import { ${exportName} } from "./${name}.ts";`,
    "",
    `test("${name} runs", async () => {`,
    "  const client = stubClient<Client>({});",
    `  const result = await invokeCLI({ "${name}": ${exportName} }, client, ["${name}"]);`,
    "  assert.equal(result.exitCode, 0);",
    "});",
    "",
  ].join("\n");
}

export function runAdd(kind: string, name: string, options: AddOptions): BinResult {
  if (!(ADD_KINDS as readonly string[]).includes(kind)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `unknown kind "${kind}" — expected query, mutation, or command\n`,
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
  let wire: string | undefined;
  if (isProcedure) {
    // Procedures print their wire name, which needs the plugin id.
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
      if (typeof pkg.name !== "string") {
        throw new Error('package.json has no "name"');
      }
      wire = wireName(derivePluginID(pkg.name), camelName(name));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { exitCode: 1, stdout: "", stderr: `${message}\n` };
    }
  }

  const dir = isProcedure ? "rpc" : "cli";
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
        : commandTemplate(name, exportName);
  const testContent = isProcedure
    ? procedureTestTemplate(name, exportName, kind as AddKind)
    : commandTestTemplate(name, exportName);

  mkdirSync(join(options.cwd, dir), { recursive: true });
  writeFileSync(join(options.cwd, unitRelative), unitContent);
  writeFileSync(join(options.cwd, testRelative), testContent);

  const lines = [`created ${unitRelative}`, `created ${testRelative}`, ""];
  lines.push("wire it in server.ts — the import:", "");
  lines.push(`  import { ${exportName} } from "./${unitRelative}";`, "");
  if (isProcedure) {
    lines.push("and the procedures entry:", "", `  ${exportName},`, "");
    lines.push(`wire name: ${wire}`);
  } else {
    const entry = name === exportName ? `${exportName},` : `"${name}": ${exportName},`;
    lines.push("and the cli.commands entry:", "", `  ${entry}`, "");
    lines.push(`(the commands key must stay "${name}" — check rule 1 pins it to the filename)`);
  }
  return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}
