import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, normalize, posix } from "node:path";
import { pathToFileURL } from "node:url";
import type * as TS from "typescript";
import type { BinResult } from "./shared.ts";
import {
  UNIT_NAME_PATTERN,
  camelName,
  compositionRootFromPkg,
  resolveImport,
  unitDir,
} from "./shared.ts";
import { derivePluginID } from "./derive-plugin-id.ts";

/**
 * `bb-kit check` (§7): static verification of the six rules — wiring
 * bijection and naming (1), definePlugin id = derived plugin id (2), the name
 * table (3), manifest paths and engines (4),
 * composition and host CLI policy (5), sibling tests (warn-only, 6).
 *
 * check EXECUTES no plugin code. Parsing goes through the plugin's own
 * TypeScript — the plugin's `typescript` package (a plain CJS library;
 * the scaffold pins 6.x) is required in process and drives a syntax-only
 * program; the plugin's sources are only ever read, never imported. The
 * host CLI policy is read from the plugin's own SDK
 * (`internal/host-policy`), a constants module. Lint, typecheck, and
 * running tests are out of scope forever.
 */

export type CheckOptions = { cwd: string };

type Finding = { file?: string; line?: number; message: string };

type TSModule = typeof TS;
type Project = {
  ts: TSModule;
  program: TS.Program;
};

function loadProject(
  cwd: string,
  requireFromPlugin: NodeJS.Require,
): { project?: Project; failure?: string } {
  let ts: TSModule;
  try {
    ts = requireFromPlugin("typescript") as TSModule;
  } catch {
    return {
      failure:
        "could not resolve TypeScript from the plugin — check parses with the plugin's own compiler (the scaffold pins typescript 6.0.3); install devDependencies first",
    };
  }
  const tsconfigPath = join(cwd, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    return {
      failure:
        "tsconfig.json not found — check parses files through the plugin's TypeScript project",
    };
  }
  try {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error !== undefined) {
      const detail = ts.flattenDiagnosticMessageText(configFile.error.messageText, " ");
      return { failure: `tsconfig.json did not load as a TypeScript project: ${detail}` };
    }
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      cwd,
      undefined,
      tsconfigPath,
    );
    const [configError] = parsed.errors;
    if (configError !== undefined) {
      const detail = ts.flattenDiagnosticMessageText(configError.messageText, " ");
      return { failure: `tsconfig.json has config errors: ${detail}` };
    }
    // The program spans the tsconfig's files WITH imports resolved, so a
    // unit file the include list omits but the composition root imports still
    // enters it — membership is program membership, as it was under the
    // TS7 project. noLib and types: [] keep the default lib and @types
    // packages out; only syntactic diagnostics are ever read.
    const program = ts.createProgram(parsed.fileNames, {
      ...parsed.options,
      noLib: true,
      types: [],
    });
    return { project: { ts, program } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { failure: `the plugin's TypeScript could not parse the project: ${message}` };
  }
}

/** 1-based line of the exact `position` in `sourceFile`. */
function lineAt(sourceFile: TS.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

/** 1-based line of `node`'s first token, past its leading trivia. */
function lineOfNode(sourceFile: TS.SourceFile, node: TS.Node): number {
  return lineAt(sourceFile, node.getStart(sourceFile));
}

function unitBasename(relativePath: string): string {
  const file = relativePath.split("/").pop() ?? relativePath;
  return file.replace(/\.tsx?$/, "");
}

export async function runCheck(options: CheckOptions): Promise<BinResult> {
  const cwd = existsSync(options.cwd) ? realpathSync(options.cwd) : options.cwd;
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const fail = (message: string, file?: string, line?: number): void => {
    errors.push({ message, file, line });
  };
  const warn = (message: string, file?: string, line?: number): void => {
    warnings.push({ message, file, line });
  };
  let table = "";

  // ---- package.json + plugin id -------------------------------------
  const packageJsonPath = join(cwd, "package.json");
  let pkg: Record<string, unknown> | undefined;
  if (!existsSync(packageJsonPath)) {
    fail("not found — run check at the plugin root", "package.json");
  } else {
    try {
      pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(`unparseable JSON: ${message}`, "package.json");
    }
  }
  let id: string | undefined;
  if (pkg) {
    if (typeof pkg["name"] === "string") {
      try {
        id = derivePluginID(pkg["name"]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(message, "package.json");
      }
    } else {
      fail('missing "name"', "package.json");
    }
  }

  // ---- rule 4: manifest paths + engines (filesystem only) -----------
  if (pkg) {
    checkManifest(pkg, cwd, fail);
  }

  // ---- unit inventory, rule 1 basenames, rule 6 sibling tests -------
  const compositionRoot = compositionRootFromPkg(pkg) ?? "server/server.ts";
  const rpcDir = unitDir(compositionRoot, "rpc");
  const cliDir = unitDir(compositionRoot, "cli");
  const listUnits = (dir: string): string[] => {
    const absolute = join(cwd, dir);
    if (!existsSync(absolute)) {
      return [];
    }
    return readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter(
        (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts"),
      )
      .sort()
      .map((name) => `${dir}/${name}`);
  };
  const rpcUnits = listUnits(rpcDir);
  const cliUnits = listUnits(cliDir);
  const unitFiles = new Set([...rpcUnits, ...cliUnits]);
  for (const unit of unitFiles) {
    const base = unitBasename(unit);
    if (!UNIT_NAME_PATTERN.test(base)) {
      fail(`unit filename must be kebab-case (${UNIT_NAME_PATTERN}) — rule 1`, unit);
    }
    const sibling = `${unit.replace(/\.tsx?$/, "")}.test.ts`;
    if (!existsSync(join(cwd, sibling))) {
      warn(`no sibling test ${sibling} — rule 6`, unit);
    }
  }

  // ---- the plugin's TypeScript project ------------------------------
  const requireFromPlugin = createRequire(join(cwd, "package.json"));
  const { project, failure } = loadProject(cwd, requireFromPlugin);
  if (failure !== undefined) {
    fail(`${failure} (parse-dependent rules skipped)`);
  }

  let pluginId: string | undefined;
  if (project) {
    const ts = project.ts;
    const stringText = (node: TS.Node | undefined): string | undefined =>
      node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        ? node.text
        : undefined;
    const hasModifier = (
      node: { modifiers?: TS.NodeArray<TS.ModifierLike> },
      kind: TS.SyntaxKind,
    ): boolean => node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;

    /** Parse one file; unparseable = failure, dependent analyses skip it. */
    const parseChecked = (relativePath: string): TS.SourceFile | undefined => {
      const sourceFile = project.program.getSourceFile(join(cwd, relativePath));
      if (!sourceFile) {
        fail("not included by tsconfig.json — check parses through the project", relativePath);
        return undefined;
      }
      const [first] = project.program.getSyntacticDiagnostics(sourceFile);
      if (first) {
        fail(
          `syntax error: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`,
          relativePath,
          lineAt(sourceFile, first.start),
        );
        return undefined;
      }
      return sourceFile;
    };

    // ---- rule 1 per unit: exactly one value export, camel(filename)
    for (const unit of unitFiles) {
      const sourceFile = parseChecked(unit);
      if (!sourceFile) {
        continue;
      }
      const expected = camelName(unitBasename(unit));
      const found: { name: string; line: number }[] = [];
      for (const statement of sourceFile.statements) {
        const line = lineOfNode(sourceFile, statement);
        if (
          ts.isVariableStatement(statement) &&
          hasModifier(statement, ts.SyntaxKind.ExportKeyword)
        ) {
          for (const declaration of statement.declarationList.declarations) {
            const name = ts.isIdentifier(declaration.name)
              ? declaration.name.text
              : "(destructuring)";
            found.push({ name, line });
          }
        } else if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isEnumDeclaration(statement) ||
            ts.isModuleDeclaration(statement)) &&
          hasModifier(statement, ts.SyntaxKind.ExportKeyword)
        ) {
          const name = hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
            ? "default"
            : (statement.name?.text ?? "default");
          found.push({ name, line });
        } else if (ts.isExportAssignment(statement)) {
          found.push({ name: "default", line });
        } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
          const clause = statement.exportClause;
          if (clause !== undefined && ts.isNamedExports(clause)) {
            for (const element of clause.elements) {
              if (!element.isTypeOnly) {
                found.push({
                  name: element.name.text,
                  line: lineOfNode(sourceFile, element),
                });
              }
            }
          } else {
            found.push({ name: "*", line });
          }
        }
      }
      if (found.length !== 1 || found[0]?.name !== expected) {
        const names = found.map((entry) => entry.name).join(", ") || "none";
        fail(
          `must have exactly one value export named "${expected}" (found: ${names}); \`export type\` stays unrestricted — rule 1`,
          unit,
          found[0]?.line,
        );
      }
      if (unit.startsWith(`${cliDir}/`)) {
        warnConfigureAction(unit, sourceFile);
      }
    }

    // ---- rule 5 warn: `.action(` inside a configure body
    function warnConfigureAction(relativePath: string, sourceFile: TS.SourceFile): void {
      const visit = (node: TS.Node): undefined => {
        if (
          (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) &&
          ts.isIdentifier(node.name) &&
          node.name.text === "configure"
        ) {
          const slice = sourceFile.text.slice(node.pos, node.end);
          const index = slice.indexOf(".action(");
          if (index !== -1) {
            warn(
              "`.action(` inside a configure body — return a CLIResult from run instead; a commander action bypasses the CLI result contract",
              relativePath,
              lineAt(sourceFile, node.pos + index),
            );
          }
        }
        node.forEachChild(visit);
        return undefined;
      };
      for (const statement of sourceFile.statements) {
        visit(statement);
      }
    }

    // ---- composition root (rules 1, 2, 3, 5) ----------------------
    const serverRelative = compositionRootFromPkg(pkg);
    let proceduresRead = false;
    let commandsRead = false;
    const procedureEntries: { key: string; line: number; valueName?: string }[] = [];
    const commandEntries: { key: string; line: number; valueName?: string }[] = [];
    const imports = new Map<string, { specifier: string; imported: string; line: number }>();
    const wired = new Set<string>();

    if (serverRelative === undefined) {
      fail("bb.server is required — rule 5", "package.json");
    } else if (!existsSync(join(cwd, serverRelative))) {
      fail(`${serverRelative} not found — rule 5`, serverRelative);
    } else {
      const sourceFile = parseChecked(serverRelative);
      if (sourceFile) {
        // Value imports: local name → specifier + imported name.
        for (const statement of sourceFile.statements) {
          if (!ts.isImportDeclaration(statement)) {
            continue;
          }
          const specifier = stringText(statement.moduleSpecifier);
          const clause = statement.importClause;
          if (specifier === undefined || clause === undefined || clause.isTypeOnly) {
            continue;
          }
          const line = lineOfNode(sourceFile, statement);
          const defaultLocal = clause.name?.text;
          if (defaultLocal !== undefined) {
            imports.set(defaultLocal, { specifier, imported: "default", line });
          }
          const bindings = clause.namedBindings;
          if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              if (element.isTypeOnly) {
                continue;
              }
              const local = element.name.text;
              imports.set(local, {
                specifier,
                imported: element.propertyName?.text ?? local,
                line: lineOfNode(sourceFile, element),
              });
            }
          }
        }
        // Top-level initializers, to chase `const rpc = { ping }`.
        const topInitializers = new Map<string, TS.Expression>();
        for (const statement of sourceFile.statements) {
          if (!ts.isVariableStatement(statement)) {
            continue;
          }
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
              topInitializers.set(declaration.name.text, declaration.initializer);
            }
          }
        }
        const unwrap = (node: TS.Node | undefined): TS.Node | undefined => {
          let current = node;
          while (
            current !== undefined &&
            (ts.isParenthesizedExpression(current) ||
              ts.isAsExpression(current) ||
              ts.isSatisfiesExpression(current))
          ) {
            current = current.expression;
          }
          return current;
        };
        const namesCalling = (calleeName: string): Set<string> => {
          const names = new Set([calleeName]);
          for (const [local, binding] of imports) {
            if (binding.imported === calleeName) {
              names.add(local);
            }
          }
          return names;
        };
        const resolveCall = (
          node: TS.Node | undefined,
          calleeName: string,
          depth = 0,
        ): TS.CallExpression | undefined => {
          const expression = unwrap(node);
          if (expression === undefined || depth > 5) {
            return undefined;
          }
          if (ts.isCallExpression(expression)) {
            const callee = unwrap(expression.expression);
            return callee !== undefined &&
              ts.isIdentifier(callee) &&
              namesCalling(calleeName).has(callee.text)
              ? expression
              : undefined;
          }
          if (ts.isIdentifier(expression)) {
            const initializer = topInitializers.get(expression.text);
            return initializer !== undefined
              ? resolveCall(initializer, calleeName, depth + 1)
              : undefined;
          }
          return undefined;
        };
        const resolveObjectLiteral = (
          node: TS.Node | undefined,
          depth = 0,
        ): TS.ObjectLiteralExpression | undefined => {
          const expression = unwrap(node);
          if (expression === undefined || depth > 5) {
            return undefined;
          }
          if (ts.isObjectLiteralExpression(expression)) {
            return expression;
          }
          if (ts.isIdentifier(expression)) {
            const initializer = topInitializers.get(expression.text);
            return initializer !== undefined
              ? resolveObjectLiteral(initializer, depth + 1)
              : undefined;
          }
          return undefined;
        };
        const propertyKeyOf = (property: TS.ObjectLiteralElementLike): string | undefined => {
          const name = property.name;
          if (name === undefined) {
            return undefined;
          }
          return ts.isIdentifier(name) ? name.text : stringText(name);
        };
        const getProperty = (
          objectLiteral: TS.ObjectLiteralExpression,
          key: string,
        ): TS.ObjectLiteralElementLike | undefined =>
          objectLiteral.properties.find((property) => propertyKeyOf(property) === key);
        const propertyValue = (
          property: TS.ObjectLiteralElementLike | undefined,
        ): TS.Node | undefined => {
          if (property === undefined) {
            return undefined;
          }
          if (ts.isShorthandPropertyAssignment(property)) {
            return property.name;
          }
          if (ts.isPropertyAssignment(property)) {
            return property.initializer;
          }
          return undefined;
        };
        const collectEntries = (
          objectLiteral: TS.ObjectLiteralExpression,
          into: { key: string; line: number; valueName?: string }[],
          what: string,
        ): void => {
          for (const property of objectLiteral.properties) {
            const line = lineOfNode(sourceFile, property);
            if (ts.isSpreadAssignment(property)) {
              fail(
                `a ${what} spread is outside what check can verify — rule 1`,
                serverRelative,
                line,
              );
              continue;
            }
            const key = propertyKeyOf(property);
            if (key === undefined) {
              fail(`unreadable ${what} key — rule 1`, serverRelative, line);
              continue;
            }
            let valueName: string | undefined;
            if (ts.isShorthandPropertyAssignment(property)) {
              valueName = key;
            } else if (ts.isPropertyAssignment(property)) {
              const value = unwrap(property.initializer);
              if (value !== undefined && ts.isObjectLiteralExpression(value) && what === "cli") {
                fail(
                  "commands must be flat — nesting is not supported (rule 5)",
                  serverRelative,
                  line,
                );
                continue;
              }
              valueName = value !== undefined && ts.isIdentifier(value) ? value.text : undefined;
            }
            if (valueName === undefined) {
              fail(
                `${what} entry "${key}" must reference an imported unit — rule 1`,
                serverRelative,
                line,
              );
            }
            into.push({ key, line, valueName });
          }
        };

        const exportAssignment = sourceFile.statements.find(ts.isExportAssignment);
        if (exportAssignment === undefined) {
          fail(`${serverRelative} has no default export — rule 5`, serverRelative);
        } else {
          const exportLine = lineOfNode(sourceFile, exportAssignment);
          const pluginCall = resolveCall(exportAssignment.expression, "definePlugin");
          const argument = pluginCall ? resolveObjectLiteral(pluginCall.arguments[0]) : undefined;
          if (pluginCall === undefined || argument === undefined) {
            fail(
              "the default export must be a single definePlugin({ ... }) call — rule 5",
              serverRelative,
              exportLine,
            );
          } else {
            const idProperty = getProperty(argument, "pluginId");
            pluginId = stringText(unwrap(propertyValue(idProperty)));
            if (pluginId === undefined) {
              fail(
                "definePlugin's pluginId must be a string literal for check to verify it — rule 2",
                serverRelative,
                lineOfNode(sourceFile, idProperty ?? argument),
              );
            }
            // rpc → object literal (inline or `const rpc = { ... }`)
            const rpcValue = propertyValue(getProperty(argument, "rpc"));
            const rpcObject = resolveObjectLiteral(rpcValue);
            if (rpcObject === undefined) {
              fail(
                'definePlugin\'s "rpc" must resolve to an object literal for check to read it',
                serverRelative,
                exportLine,
              );
            } else {
              collectEntries(rpcObject, procedureEntries, "rpc");
              proceduresRead = true;
            }
            // cli → object literal (inline or `const cli = { ... }`)
            const cliProperty = getProperty(argument, "cli");
            if (cliProperty === undefined) {
              if (cliUnits.length > 0) {
                fail(
                  `${cliDir}/ has unit files but definePlugin has no cli entry — rule 5`,
                  serverRelative,
                  exportLine,
                );
              } else {
                commandsRead = true;
              }
            } else {
              const cliObject = resolveObjectLiteral(propertyValue(cliProperty));
              if (cliObject === undefined) {
                fail(
                  'the "cli" entry must resolve to an object literal',
                  serverRelative,
                  lineOfNode(sourceFile, cliProperty),
                );
              } else {
                collectEntries(cliObject, commandEntries, "cli");
                commandsRead = true;
              }
            }
          }
        }

        // Entry → unit file resolution (rule 1).
        const resolveEntryFile = (
          valueName: string,
          line: number,
          expectDir: "rpc" | "cli",
        ): string | undefined => {
          const binding = imports.get(valueName);
          if (binding === undefined) {
            fail(`"${valueName}" is not imported in ${serverRelative} — rule 1`, serverRelative, line);
            return undefined;
          }
          const relative = resolveImport(serverRelative, binding.specifier);
          const expectedDir = unitDir(serverRelative, expectDir);
          if (posix.dirname(relative) !== expectedDir || !/\.tsx?$/.test(relative)) {
            fail(
              `"${valueName}" imports "${binding.specifier}" — a ${expectedDir}/ unit file was expected (rule 1)`,
              serverRelative,
              line,
            );
            return undefined;
          }
          if (!unitFiles.has(relative)) {
            fail(
              `"${valueName}" resolves to ${relative}, which is not a unit file on disk — rule 1`,
              serverRelative,
              line,
            );
            return undefined;
          }
          return relative;
        };
        for (const entry of procedureEntries) {
          if (entry.valueName === undefined) {
            continue;
          }
          const relative = resolveEntryFile(entry.valueName, entry.line, "rpc");
          if (relative !== undefined) {
            // "exactly once": a second key wiring the same unit file
            // breaks injectivity even when the public names differ.
            if (wired.has(relative)) {
              fail(
                `RPC key "${entry.key}" wires ${relative}, which is already wired — rule 1`,
                serverRelative,
                entry.line,
              );
            }
            wired.add(relative);
          }
        }
        for (const entry of commandEntries) {
          if (entry.key === "rpc" || entry.key === "help") {
            fail(`commands key "${entry.key}" is reserved — rule 5`, serverRelative, entry.line);
          }
          if (entry.valueName === undefined) {
            continue;
          }
          const relative = resolveEntryFile(entry.valueName, entry.line, "cli");
          if (relative !== undefined) {
            wired.add(relative);
            const base = unitBasename(relative);
            if (entry.key !== base) {
              fail(
                `commands key "${entry.key}" must equal the unit's kebab basename "${base}" — rule 1`,
                serverRelative,
                entry.line,
              );
            }
          }
        }
        // Bijection: every unit file wired exactly once (rule 1).
        if (proceduresRead) {
          for (const unit of rpcUnits) {
            if (!wired.has(unit)) {
              fail(`not wired into ${serverRelative} rpc — rule 1`, unit);
            }
          }
        }
        if (commandsRead) {
          for (const unit of cliUnits) {
            if (!wired.has(unit)) {
              fail(`not wired into ${serverRelative} cli — rule 1`, unit);
            }
          }
        }
        // rule 2: definePlugin pluginId equals the derived plugin id.
        if (pluginId !== undefined && id !== undefined && pluginId !== id) {
          fail(
            `plugin id "${pluginId}" must equal derivePluginID(package.json name) = "${id}" — rule 2`,
            serverRelative,
          );
        }
        // rule 3: the name table. The public name is the key.
        if (proceduresRead) {
          const rows = procedureEntries.map((entry) => `  ${entry.key}`);
          if (rows.length > 0) {
            table = `RPC names:\n${rows.join("\n")}\n`;
          }
        }
      }
    }
  }

  // ---- rule 5: host CLI policy, from the plugin's own SDK -----------
  const cliName = pluginId ?? id;
  if (cliName !== undefined) {
    try {
      const policyPath = requireFromPlugin.resolve("@get-bb/plugin-sdk/internal/host-policy");
      const policy = (await import(pathToFileURL(policyPath).href)) as {
        CLI_COMMAND_NAME_PATTERN?: RegExp;
        RESERVED_BB_CLI_COMMANDS?: readonly string[];
      };
      const pattern = policy.CLI_COMMAND_NAME_PATTERN;
      const reserved = policy.RESERVED_BB_CLI_COMMANDS;
      if (pattern instanceof RegExp && !pattern.test(cliName)) {
        fail(`plugin CLI name "${cliName}" does not match the host's ${String(pattern)} — rule 5`);
      }
      if (Array.isArray(reserved) && reserved.includes(cliName)) {
        fail(`plugin CLI name "${cliName}" is reserved by bb — rule 5`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(
        `could not load the host CLI policy from the plugin's SDK (@get-bb/plugin-sdk/internal/host-policy): ${message} — rule 5 skipped`,
      );
    }
  }

  // ---- report -------------------------------------------------------
  const format = (finding: Finding, label: string): string => {
    const location =
      finding.file !== undefined
        ? `${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""} — `
        : "";
    return `${label}: ${location}${finding.message}\n`;
  };
  let stderr = "";
  for (const finding of errors) {
    stderr += format(finding, "error");
  }
  for (const finding of warnings) {
    stderr += format(finding, "warning");
  }
  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
  let stdout = table === "" ? "" : `${table}\n`;
  stdout +=
    errors.length > 0
      ? `check failed: ${count(errors.length, "error")}, ${count(warnings.length, "warning")}\n`
      : warnings.length > 0
        ? `check passed with ${count(warnings.length, "warning")}\n`
        : "check passed\n";
  return { exitCode: errors.length > 0 ? 1 : 0, stdout, stderr };
}

// ---- rule 4 ---------------------------------------------------------

function checkManifest(
  pkg: Record<string, unknown>,
  cwd: string,
  fail: (message: string, file?: string, line?: number) => void,
): void {
  const checkPath = (label: string, value: unknown, required: boolean): void => {
    if (value === undefined) {
      if (required) {
        fail(`${label} is required`, "package.json");
      }
      return;
    }
    if (typeof value !== "string" || value === "") {
      fail(`${label} must be a non-empty string path`, "package.json");
      return;
    }
    if (isAbsolute(value)) {
      fail(`${label} "${value}" must be relative — rule 4`, "package.json");
      return;
    }
    const normalized = normalize(value);
    if (normalized === ".." || normalized.startsWith(`..${"/"}`)) {
      fail(`${label} "${value}" escapes the package — rule 4`, "package.json");
      return;
    }
    const [firstSegment] = normalized.split("/");
    if (firstSegment === "dist" || firstSegment === "build" || firstSegment === "out") {
      fail(`${label} "${value}" points at build output — rule 4`, "package.json");
      return;
    }
    if (!existsSync(join(cwd, normalized))) {
      fail(`${label} "${value}" does not exist — rule 4`, "package.json");
    }
  };

  const bb = pkg["bb"];
  if (bb === undefined || bb === null || typeof bb !== "object" || Array.isArray(bb)) {
    fail('missing the "bb" manifest section — rule 4', "package.json");
  } else {
    const manifest = bb as Record<string, unknown>;
    checkPath("bb.server", manifest["server"], true);
    checkPath("bb.app", manifest["app"], false);
    checkPath("bb.theme", manifest["theme"], false);
    const branding = manifest["branding"];
    if (branding === undefined || branding === null || typeof branding !== "object") {
      fail(
        "bb.branding is required by the host manifest schema (an icon or a logo) — rule 4",
        "package.json",
      );
    } else {
      const brandingRecord = branding as Record<string, unknown>;
      const logo = (brandingRecord["logo"] ?? {}) as Record<string, unknown>;
      const entries: [string, unknown][] = [
        ["bb.branding.icon", brandingRecord["icon"]],
        ["bb.branding.logo.light", logo["light"]],
        ["bb.branding.logo.dark", logo["dark"]],
      ];
      let any = false;
      for (const [label, value] of entries) {
        if (value === undefined) {
          continue;
        }
        any = true;
        checkPath(label, value, false);
        if (typeof value === "string" && !value.endsWith(".svg")) {
          fail(`${label} "${value}" must be an .svg — rule 4`, "package.json");
        }
      }
      if (!any) {
        fail("bb.branding needs an icon or a logo.light path — rule 4", "package.json");
      }
    }
    const skills = manifest["skills"];
    if (skills !== undefined) {
      if (!Array.isArray(skills)) {
        fail("bb.skills must be an array — rule 4", "package.json");
      } else {
        for (const skill of skills) {
          checkPath("bb.skills entry", skill, false);
        }
      }
    }
  }

  const engines = pkg["engines"];
  if (engines !== undefined && engines !== null && typeof engines === "object") {
    for (const [key, value] of Object.entries(engines as Record<string, unknown>)) {
      if (typeof value !== "string" || !isValidSemverRange(value)) {
        fail(
          `engines.${key} ${JSON.stringify(value)} is not a valid semver range — rule 4`,
          "package.json",
        );
      }
    }
  }
}

/**
 * A pragmatic semver-range validator (no dependency): `||` alternatives
 * of space-separated comparators, each an optionally-operated version
 * (`^ ~ > >= < <= =`) with x/* wildcards, or a hyphen range, or `*`.
 */
export function isValidSemverRange(range: string): boolean {
  const version = String.raw`(?:\d+|x|X|\*)(?:\.(?:\d+|x|X|\*)){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
  const comparator = `(?:\\^|~|>=|<=|>|<|=)?${version}`;
  const hyphenRange = `${version}\\s+-\\s+${version}`;
  const simple = new RegExp(`^(?:\\*|${hyphenRange}|${comparator}(?:\\s+${comparator})*)$`);
  return range
    .split("||")
    .map((part) => part.trim())
    .every((part) => part === "" || simple.test(part));
}
