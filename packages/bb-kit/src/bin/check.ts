import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import type { BinResult } from "./shared.ts";
import { UNIT_NAME_PATTERN, camelName } from "./shared.ts";
import { derivePluginID } from "./derive-plugin-id.ts";
import { kebabName, wireName } from "../internal/wire-name.ts";

/**
 * `bb-kit check` (§7): static verification of the six rules — wiring
 * bijection and naming (1), namespace = plugin id (2), wire-name
 * uniqueness plus the full table (3), manifest paths and engines (4),
 * composition and host CLI policy (5), sibling tests (warn-only, 6).
 *
 * check EXECUTES no plugin code. Parsing goes through the plugin's own
 * TypeScript — with TS 7 that means the bundled native compiler is
 * spawned as a parser service (`typescript/unstable/sync`); the plugin's
 * sources are only ever read, never imported. The host CLI policy is
 * read from the plugin's own SDK (`internal/host-policy`), a constants
 * module. Lint, typecheck, and running tests are out of scope forever.
 */

export type CheckOptions = { cwd: string };

type Finding = { file?: string; line?: number; message: string };

/** The slice of a TS 7 AST node the analyses read (fields are prototype
 * getters, so traversal uses the node's own `forEachChild`). */
type TSNode = {
  kind: number;
  pos: number;
  end: number;
  forEachChild<T>(callback: (child: TSNode) => T | undefined): T | undefined;
  text?: string;
  name?: TSNode;
  expression?: TSNode;
  initializer?: TSNode;
  declarationList?: { declarations?: readonly TSNode[] };
  modifiers?: readonly TSNode[];
  importClause?: { isTypeOnly?: boolean; name?: TSNode; namedBindings?: TSNode };
  moduleSpecifier?: TSNode;
  exportClause?: TSNode;
  elements?: readonly TSNode[];
  isTypeOnly?: boolean;
  properties?: readonly TSNode[];
  arguments?: readonly TSNode[];
};
type TSSourceFile = TSNode & { text: string; statements: readonly TSNode[] };

type TS7Program = {
  getSourceFile(fileName: string): TSSourceFile | undefined;
  getSyntacticDiagnostics(fileName: string): readonly { pos: number; text: string }[];
};
type Toolchain = {
  kinds: Record<string, number>;
  program: TS7Program;
  close(): void;
};

async function loadToolchain(
  cwd: string,
  requireFromPlugin: NodeJS.Require,
): Promise<{ toolchain?: Toolchain; failure?: string }> {
  let syncPath: string;
  let astPath: string;
  try {
    syncPath = requireFromPlugin.resolve("typescript/unstable/sync");
    astPath = requireFromPlugin.resolve("typescript/unstable/ast");
  } catch {
    return {
      failure:
        "could not resolve TypeScript 7 from the plugin — check parses with the plugin's own compiler (the scaffold pins typescript 7.0.2); install devDependencies first",
    };
  }
  const tsconfigPath = join(cwd, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    return {
      failure:
        "tsconfig.json not found — check parses files through the plugin's TypeScript project",
    };
  }
  const sync = (await import(pathToFileURL(syncPath).href)) as {
    API: new (options: { cwd: string }) => {
      updateSnapshot(params: { openProjects: string[] }): {
        getProjects(): readonly { program: TS7Program }[];
      };
      close(): void;
    };
  };
  const ast = (await import(pathToFileURL(astPath).href)) as {
    SyntaxKind: Record<string, number>;
  };
  let api: InstanceType<typeof sync.API> | undefined;
  try {
    api = new sync.API({ cwd });
    const snapshot = api.updateSnapshot({ openProjects: [tsconfigPath] });
    const project = snapshot.getProjects()[0];
    if (!project) {
      api.close();
      return { failure: "tsconfig.json did not load as a TypeScript project" };
    }
    const owner = api;
    return {
      toolchain: {
        kinds: ast.SyntaxKind,
        program: project.program,
        close: () => owner.close(),
      },
    };
  } catch (error) {
    try {
      api?.close();
    } catch {
      // the spawn already failed; nothing to release
    }
    const message = error instanceof Error ? error.message : String(error);
    return { failure: `the plugin's TypeScript could not start: ${message}` };
  }
}

/** 1-based line of `pos`, skipping the leading trivia the pos includes. */
function lineOf(sourceText: string, pos: number): number {
  let start = pos;
  while (start < sourceText.length && /\s/.test(sourceText.charAt(start))) {
    start += 1;
  }
  let line = 1;
  for (let index = 0; index < start && index < sourceText.length; index += 1) {
    if (sourceText.charAt(index) === "\n") {
      line += 1;
    }
  }
  return line;
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
  const listUnits = (dir: "rpc" | "cli"): string[] => {
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
  const rpcUnits = listUnits("rpc");
  const cliUnits = listUnits("cli");
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

  // ---- toolchain ----------------------------------------------------
  const requireFromPlugin = createRequire(join(cwd, "package.json"));
  const { toolchain, failure } = await loadToolchain(cwd, requireFromPlugin);
  if (failure !== undefined) {
    fail(`${failure} (parse-dependent rules skipped)`);
  }

  let namespace: string | undefined;
  try {
    if (toolchain) {
      const kinds = toolchain.kinds;
      const requireKind = (name: string): number => {
        const value = kinds[name];
        if (value === undefined) {
          throw new Error(`the plugin's TypeScript has no SyntaxKind.${name}`);
        }
        return value;
      };
      const K = {
        Identifier: requireKind("Identifier"),
        StringLiteral: requireKind("StringLiteral"),
        NoSubstitutionTemplateLiteral: requireKind("NoSubstitutionTemplateLiteral"),
        CallExpression: requireKind("CallExpression"),
        ObjectLiteralExpression: requireKind("ObjectLiteralExpression"),
        PropertyAssignment: requireKind("PropertyAssignment"),
        ShorthandPropertyAssignment: requireKind("ShorthandPropertyAssignment"),
        SpreadAssignment: requireKind("SpreadAssignment"),
        MethodDeclaration: requireKind("MethodDeclaration"),
        ParenthesizedExpression: requireKind("ParenthesizedExpression"),
        AsExpression: requireKind("AsExpression"),
        SatisfiesExpression: requireKind("SatisfiesExpression"),
        VariableStatement: requireKind("VariableStatement"),
        FunctionDeclaration: requireKind("FunctionDeclaration"),
        ClassDeclaration: requireKind("ClassDeclaration"),
        EnumDeclaration: requireKind("EnumDeclaration"),
        ModuleDeclaration: requireKind("ModuleDeclaration"),
        ImportDeclaration: requireKind("ImportDeclaration"),
        NamedImports: requireKind("NamedImports"),
        ExportAssignment: requireKind("ExportAssignment"),
        ExportDeclaration: requireKind("ExportDeclaration"),
        NamedExports: requireKind("NamedExports"),
        ExportKeyword: requireKind("ExportKeyword"),
        DefaultKeyword: requireKind("DefaultKeyword"),
      };
      const stringText = (node: TSNode | undefined): string | undefined =>
        node !== undefined &&
        (node.kind === K.StringLiteral || node.kind === K.NoSubstitutionTemplateLiteral)
          ? node.text
          : undefined;
      const hasModifier = (node: TSNode, kind: number): boolean =>
        node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;

      /** Parse one file; unparseable = failure, dependent analyses skip it. */
      const parseChecked = (relativePath: string): TSSourceFile | undefined => {
        const absolute = join(cwd, relativePath);
        const sourceFile = toolchain.program.getSourceFile(absolute);
        if (!sourceFile) {
          fail("not included by tsconfig.json — check parses through the project", relativePath);
          return undefined;
        }
        const [first] = toolchain.program.getSyntacticDiagnostics(absolute);
        if (first) {
          fail(`syntax error: ${first.text}`, relativePath, lineOf(sourceFile.text, first.pos));
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
          const line = lineOf(sourceFile.text, statement.pos);
          if (statement.kind === K.VariableStatement && hasModifier(statement, K.ExportKeyword)) {
            for (const declaration of statement.declarationList?.declarations ?? []) {
              const name =
                declaration.name?.kind === K.Identifier
                  ? (declaration.name.text ?? "(unknown)")
                  : "(destructuring)";
              found.push({ name, line });
            }
          } else if (
            (statement.kind === K.FunctionDeclaration ||
              statement.kind === K.ClassDeclaration ||
              statement.kind === K.EnumDeclaration ||
              statement.kind === K.ModuleDeclaration) &&
            hasModifier(statement, K.ExportKeyword)
          ) {
            const name = hasModifier(statement, K.DefaultKeyword)
              ? "default"
              : (statement.name?.text ?? "default");
            found.push({ name, line });
          } else if (statement.kind === K.ExportAssignment) {
            found.push({ name: "default", line });
          } else if (statement.kind === K.ExportDeclaration && statement.isTypeOnly !== true) {
            const clause = statement.exportClause;
            if (clause !== undefined && clause.kind === K.NamedExports) {
              for (const element of clause.elements ?? []) {
                if (element.isTypeOnly !== true) {
                  found.push({
                    name: element.name?.text ?? "(unknown)",
                    line: lineOf(sourceFile.text, element.pos),
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
        if (unit.startsWith("cli/")) {
          warnConfigureAction(unit, sourceFile);
        }
      }

      // ---- rule 5 warn: `.action(` inside a configure body
      function warnConfigureAction(relativePath: string, sourceFile: TSSourceFile): void {
        const visit = (node: TSNode): undefined => {
          if (
            (node.kind === K.PropertyAssignment || node.kind === K.MethodDeclaration) &&
            node.name?.kind === K.Identifier &&
            node.name.text === "configure"
          ) {
            const slice = sourceFile.text.slice(node.pos, node.end);
            const index = slice.indexOf(".action(");
            if (index !== -1) {
              warn(
                "`.action(` inside a configure body — return a CLIResult from run instead; a commander action bypasses the CLI result contract",
                relativePath,
                lineOf(sourceFile.text, node.pos + index),
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

      // ---- server.ts composition (rules 1, 2, 3, 5) -----------------
      const serverRelative = "server.ts";
      let proceduresRead = false;
      let commandsRead = false;
      const procedureEntries: { key: string; line: number; valueName?: string }[] = [];
      const commandEntries: { key: string; line: number; valueName?: string }[] = [];
      const imports = new Map<string, { specifier: string; imported: string; line: number }>();
      const wired = new Set<string>();

      if (!existsSync(join(cwd, serverRelative))) {
        fail("server.ts not found — rule 5", serverRelative);
      } else {
        const sourceFile = parseChecked(serverRelative);
        if (sourceFile) {
          const sourceText = sourceFile.text;
          // Value imports: local name → specifier + imported name.
          for (const statement of sourceFile.statements) {
            if (statement.kind !== K.ImportDeclaration) {
              continue;
            }
            const specifier = stringText(statement.moduleSpecifier);
            const clause = statement.importClause;
            if (specifier === undefined || clause === undefined || clause.isTypeOnly === true) {
              continue;
            }
            const line = lineOf(sourceText, statement.pos);
            const defaultLocal = clause.name?.text;
            if (defaultLocal !== undefined) {
              imports.set(defaultLocal, { specifier, imported: "default", line });
            }
            const bindings = clause.namedBindings;
            if (bindings !== undefined && bindings.kind === K.NamedImports) {
              for (const element of bindings.elements ?? []) {
                const local = element.name?.text;
                if (local === undefined || element.isTypeOnly === true) {
                  continue;
                }
                const propertyName = (element as { propertyName?: TSNode }).propertyName;
                imports.set(local, {
                  specifier,
                  imported: propertyName?.text ?? local,
                  line: lineOf(sourceText, element.pos),
                });
              }
            }
          }
          // Top-level initializers, to chase `const rpc = defineRPC(...)`.
          const topInitializers = new Map<string, TSNode>();
          for (const statement of sourceFile.statements) {
            if (statement.kind !== K.VariableStatement) {
              continue;
            }
            for (const declaration of statement.declarationList?.declarations ?? []) {
              const name = declaration.name;
              if (
                name?.kind === K.Identifier &&
                name.text !== undefined &&
                declaration.initializer !== undefined
              ) {
                topInitializers.set(name.text, declaration.initializer);
              }
            }
          }
          const unwrap = (node: TSNode | undefined): TSNode | undefined => {
            let current = node;
            while (
              current !== undefined &&
              (current.kind === K.ParenthesizedExpression ||
                current.kind === K.AsExpression ||
                current.kind === K.SatisfiesExpression)
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
            node: TSNode | undefined,
            calleeName: string,
            depth = 0,
          ): TSNode | undefined => {
            const expression = unwrap(node);
            if (expression === undefined || depth > 5) {
              return undefined;
            }
            if (expression.kind === K.CallExpression) {
              const callee = unwrap(expression.expression);
              return callee?.kind === K.Identifier &&
                callee.text !== undefined &&
                namesCalling(calleeName).has(callee.text)
                ? expression
                : undefined;
            }
            if (expression.kind === K.Identifier && expression.text !== undefined) {
              const initializer = topInitializers.get(expression.text);
              return initializer !== undefined
                ? resolveCall(initializer, calleeName, depth + 1)
                : undefined;
            }
            return undefined;
          };
          const resolveObjectLiteral = (
            node: TSNode | undefined,
            depth = 0,
          ): TSNode | undefined => {
            const expression = unwrap(node);
            if (expression === undefined || depth > 5) {
              return undefined;
            }
            if (expression.kind === K.ObjectLiteralExpression) {
              return expression;
            }
            if (expression.kind === K.Identifier && expression.text !== undefined) {
              const initializer = topInitializers.get(expression.text);
              return initializer !== undefined
                ? resolveObjectLiteral(initializer, depth + 1)
                : undefined;
            }
            return undefined;
          };
          const propertyKeyOf = (property: TSNode): string | undefined => {
            const name = property.name;
            if (name === undefined) {
              return undefined;
            }
            return name.kind === K.Identifier ? name.text : stringText(name);
          };
          const getProperty = (objectLiteral: TSNode, key: string): TSNode | undefined =>
            objectLiteral.properties?.find((property) => propertyKeyOf(property) === key);
          const propertyValue = (property: TSNode | undefined): TSNode | undefined => {
            if (property === undefined) {
              return undefined;
            }
            if (property.kind === K.ShorthandPropertyAssignment) {
              return property.name;
            }
            if (property.kind === K.PropertyAssignment) {
              return property.initializer;
            }
            return undefined;
          };
          const collectEntries = (
            objectLiteral: TSNode,
            into: { key: string; line: number; valueName?: string }[],
            what: string,
          ): void => {
            for (const property of objectLiteral.properties ?? []) {
              const line = lineOf(sourceText, property.pos);
              if (property.kind === K.SpreadAssignment) {
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
              if (property.kind === K.ShorthandPropertyAssignment) {
                valueName = key;
              } else if (property.kind === K.PropertyAssignment) {
                const value = unwrap(property.initializer);
                if (value?.kind === K.ObjectLiteralExpression && what === "commands") {
                  fail(
                    "commands must be flat — nesting is not supported (rule 5)",
                    serverRelative,
                    line,
                  );
                  continue;
                }
                valueName = value?.kind === K.Identifier ? value.text : undefined;
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

          const exportAssignment = sourceFile.statements.find(
            (statement) => statement.kind === K.ExportAssignment,
          );
          if (exportAssignment === undefined) {
            fail("server.ts has no default export — rule 5", serverRelative);
          } else {
            const exportLine = lineOf(sourceText, exportAssignment.pos);
            const pluginCall = resolveCall(exportAssignment.expression, "definePlugin");
            const argument = pluginCall
              ? resolveObjectLiteral(pluginCall.arguments?.[0])
              : undefined;
            if (pluginCall === undefined || argument === undefined) {
              fail(
                "the default export must be a single definePlugin({ ... }) call — rule 5",
                serverRelative,
                exportLine,
              );
            } else {
              // rpc → defineRPC → namespace + procedures
              const rpcValue = propertyValue(getProperty(argument, "rpc"));
              const rpcCall = resolveCall(rpcValue, "defineRPC");
              const rpcArgument = rpcCall
                ? resolveObjectLiteral(rpcCall.arguments?.[0])
                : undefined;
              if (rpcArgument === undefined) {
                fail(
                  'definePlugin\'s "rpc" must resolve to a defineRPC({ ... }) call for check to read it',
                  serverRelative,
                  exportLine,
                );
              } else {
                const namespaceProperty = getProperty(rpcArgument, "namespace");
                namespace = stringText(unwrap(propertyValue(namespaceProperty)));
                if (namespace === undefined) {
                  fail(
                    "the namespace must be a string literal for check to verify it — rule 2",
                    serverRelative,
                    lineOf(sourceText, (namespaceProperty ?? rpcArgument).pos),
                  );
                }
                const proceduresObject = resolveObjectLiteral(
                  propertyValue(getProperty(rpcArgument, "procedures")),
                );
                if (proceduresObject === undefined) {
                  fail(
                    'defineRPC needs a "procedures" object literal — rule 1',
                    serverRelative,
                    lineOf(sourceText, rpcArgument.pos),
                  );
                } else {
                  collectEntries(proceduresObject, procedureEntries, "procedures");
                  proceduresRead = true;
                }
              }
              // cli → commands
              const cliProperty = getProperty(argument, "cli");
              if (cliProperty === undefined) {
                if (cliUnits.length > 0) {
                  fail(
                    "cli/ has unit files but definePlugin has no cli entry — rule 5",
                    serverRelative,
                    exportLine,
                  );
                } else {
                  commandsRead = true;
                }
              } else {
                const cliObject = resolveObjectLiteral(propertyValue(cliProperty));
                const commandsObject = cliObject
                  ? resolveObjectLiteral(propertyValue(getProperty(cliObject, "commands")))
                  : undefined;
                if (commandsObject === undefined) {
                  fail(
                    'the cli entry must be an object literal with a "commands" object literal — rule 5',
                    serverRelative,
                    lineOf(sourceText, cliProperty.pos),
                  );
                } else {
                  collectEntries(commandsObject, commandEntries, "commands");
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
              fail(`"${valueName}" is not imported in server.ts — rule 1`, serverRelative, line);
              return undefined;
            }
            const match = /^\.\/(rpc|cli)\/[^/]+\.tsx?$/.exec(binding.specifier);
            if (match === null || match[1] !== expectDir) {
              fail(
                `"${valueName}" imports "${binding.specifier}" — a ./${expectDir}/ unit file was expected (rule 1)`,
                serverRelative,
                line,
              );
              return undefined;
            }
            const relative = binding.specifier.slice(2);
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
            if (kebabName(entry.key) === "help") {
              fail(
                `procedure key "${entry.key}" kebab-cases to "help", colliding with the rpc subtree's help — rule 5`,
                serverRelative,
                entry.line,
              );
            }
            if (entry.valueName === undefined) {
              continue;
            }
            const relative = resolveEntryFile(entry.valueName, entry.line, "rpc");
            if (relative !== undefined) {
              // "exactly once": a second key wiring the same unit file
              // breaks injectivity even when the wire names differ.
              if (wired.has(relative)) {
                fail(
                  `procedure key "${entry.key}" wires ${relative}, which is already wired — rule 1`,
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
                fail("not wired into server.ts procedures — rule 1", unit);
              }
            }
          }
          if (commandsRead) {
            for (const unit of cliUnits) {
              if (!wired.has(unit)) {
                fail("not wired into server.ts cli.commands — rule 1", unit);
              }
            }
          }
          // rule 2: namespace equals the derived plugin id.
          if (namespace !== undefined && id !== undefined && namespace !== id) {
            fail(
              `RPC namespace "${namespace}" must equal derivePluginID(package.json name) = "${id}" — rule 2`,
              serverRelative,
            );
          }
          // rule 3: unique wire names, and the full table.
          if (namespace !== undefined && proceduresRead) {
            const byWire = new Map<string, string>();
            const rows: string[] = [];
            for (const entry of procedureEntries) {
              const wire = wireName(namespace, entry.key);
              const prior = byWire.get(wire);
              if (prior !== undefined) {
                fail(
                  `procedures "${prior}" and "${entry.key}" both produce wire name "${wire}" — rule 3`,
                  serverRelative,
                  entry.line,
                );
              } else {
                byWire.set(wire, entry.key);
              }
              rows.push(`  ${wire}  <- ${entry.key}`);
            }
            if (rows.length > 0) {
              table = `wire names (namespace "${namespace}"):\n${rows.join("\n")}\n`;
            }
          }
        }
      }
    }
  } finally {
    toolchain?.close();
  }

  // ---- rule 5: host CLI policy, from the plugin's own SDK -----------
  const cliName = namespace ?? id;
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
