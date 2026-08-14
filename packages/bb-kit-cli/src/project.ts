import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  type Expression,
  type ObjectLiteralExpression,
} from "ts-morph";

export const OPERATION_IDENTITY_PATTERN =
  /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
export const RPC_METHOD_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface PluginManifest {
  name: string;
  version?: string;
  license?: string;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: {
    bb?: string;
    bbPluginSdk?: string;
  };
  bb?: {
    server?: string;
    app?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OperationLock {
  rpcMethod: string;
}

export interface MigrationLock {
  sha256: string;
}

export interface BbKitLock {
  version: 1;
  operations: Record<string, OperationLock>;
  migrations: Record<string, MigrationLock>;
}

export interface DiscoveredOperation {
  identity: string;
  module: string;
  name: string;
  file: string;
  kind: "query" | "command" | "unknown";
  risk: "safe" | "mutating" | "destructive" | null;
  rpcMethod: string | null;
  input: DiscoveredOperationInput | null;
  metadataError: string | null;
}

export type OperationJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly OperationJsonValue[]
  | { readonly [key: string]: OperationJsonValue };

export type DiscoveredOperationInput =
  | { readonly mode: "none" }
  | { readonly mode: "required"; readonly example: OperationJsonValue };

export interface DiscoveredModule {
  name: string;
  directory: string;
  operations: DiscoveredOperation[];
  migrations: string[];
  surfaces: Array<"nav-panel" | "thread-panel">;
  storage: "sqlite" | null;
}

export interface ProjectInfo {
  root: string;
  manifest: PluginManifest;
  pluginId: string;
  serverEntry: string;
  appEntry: string | null;
  modulesRoot: string;
  modules: DiscoveredModule[];
  lock: BbKitLock;
}

export function unscopedPackageName(name: string): string {
  return name.split("/").at(-1) ?? name;
}

export function derivePluginId(name: string): string {
  const id = unscopedPackageName(name)
    .replace(/^bb-plugin-/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (id === "") throw new Error(`cannot derive a plugin id from "${name}"`);
  return id;
}

export function findProjectRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as PluginManifest;
        if (manifest.bb?.server) return current;
      } catch {
        // Let `checkProject` report a stable manifest diagnostic from this root.
        return current;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`no bb plugin package.json found from ${start}`);
    }
    current = parent;
  }
}

export function readManifest(root: string): PluginManifest {
  const value = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as unknown;
  if (typeof value !== "object" || value === null) {
    throw new Error("package.json must contain a JSON object");
  }
  const manifest = value as Partial<PluginManifest>;
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    throw new Error("package.json is missing a non-empty name");
  }
  return manifest as PluginManifest;
}

export function emptyLock(): BbKitLock {
  return { version: 1, operations: {}, migrations: {} };
}

export function readLock(root: string): BbKitLock {
  const path = join(root, "bb-kit.lock.json");
  if (!existsSync(path)) return emptyLock();
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<BbKitLock>;
  if (
    value.version !== 1
    || typeof value.operations !== "object"
    || value.operations === null
    || (value.migrations !== undefined
      && (typeof value.migrations !== "object" || value.migrations === null))
  ) {
    throw new Error("bb-kit.lock.json has an unsupported format");
  }
  for (const [identity, entry] of Object.entries(value.operations)) {
    if (
      typeof entry !== "object"
      || entry === null
      || !("rpcMethod" in entry)
      || typeof entry.rpcMethod !== "string"
    ) {
      throw new Error(`bb-kit.lock.json has an invalid operation entry for "${identity}"`);
    }
  }
  for (const [key, entry] of Object.entries(value.migrations ?? {})) {
    if (
      typeof entry !== "object"
      || entry === null
      || !("sha256" in entry)
      || typeof entry.sha256 !== "string"
    ) {
      throw new Error(`bb-kit.lock.json has an invalid migration entry for "${key}"`);
    }
  }
  return {
    version: 1,
    operations: value.operations,
    migrations: value.migrations ?? {},
  };
}

export function writeLock(root: string, lock: BbKitLock): void {
  const operations = Object.fromEntries(
    Object.entries(lock.operations).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const migrations = Object.fromEntries(
    Object.entries(lock.migrations).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  writeFileSync(
    join(root, "bb-kit.lock.json"),
    `${JSON.stringify({ version: 1, operations, migrations }, null, 2)}\n`,
  );
}

function unwrapExpression(expression: Expression): Expression {
  let current = expression;
  while (
    Node.isParenthesizedExpression(current)
    || Node.isAsExpression(current)
    || Node.isSatisfiesExpression(current)
    || Node.isTypeAssertion(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

function propertyInitializer(
  object: ObjectLiteralExpression,
  name: string,
): Expression | null {
  const property = object.getProperty(name);
  if (!property || !Node.isPropertyAssignment(property)) return null;
  return unwrapExpression(property.getInitializerOrThrow());
}

function jsonPropertyName(node: Node): string {
  if (Node.isIdentifier(node)) return node.getText();
  if (Node.isStringLiteral(node) || Node.isNumericLiteral(node)) {
    return String(node.getLiteralValue());
  }
  throw new Error("exampleInput contains a computed or unsupported property name");
}

function jsonLiteral(node: Expression): OperationJsonValue {
  const value = unwrapExpression(node);
  if (Node.isStringLiteral(value) || Node.isNumericLiteral(value)) {
    const literal = value.getLiteralValue();
    if (typeof literal === "number" && !Number.isFinite(literal)) {
      throw new Error("exampleInput contains a non-finite number");
    }
    return literal;
  }
  if (value.getKind() === SyntaxKind.NullKeyword) return null;
  if (value.getKind() === SyntaxKind.TrueKeyword) return true;
  if (value.getKind() === SyntaxKind.FalseKeyword) return false;
  if (Node.isPrefixUnaryExpression(value)) {
    if (value.getOperatorToken() !== SyntaxKind.MinusToken) {
      throw new Error("exampleInput contains an unsupported unary expression");
    }
    const operand = unwrapExpression(value.getOperand());
    if (!Node.isNumericLiteral(operand)) {
      throw new Error("exampleInput contains an unsupported unary expression");
    }
    const number = -operand.getLiteralValue();
    if (!Number.isFinite(number)) throw new Error("exampleInput contains a non-finite number");
    return number;
  }
  if (Node.isArrayLiteralExpression(value)) {
    return value.getElements().map((element) => {
      if (!Node.isExpression(element) || Node.isSpreadElement(element)) {
        throw new Error("exampleInput arrays must not contain holes or spreads");
      }
      return jsonLiteral(element);
    });
  }
  if (Node.isObjectLiteralExpression(value)) {
    const entries: Array<[string, OperationJsonValue]> = [];
    const keys = new Set<string>();
    for (const property of value.getProperties()) {
      if (!Node.isPropertyAssignment(property)) {
        throw new Error("exampleInput objects require explicit property assignments");
      }
      const key = jsonPropertyName(property.getNameNode());
      if (keys.has(key)) {
        throw new Error(`exampleInput contains duplicate property ${JSON.stringify(key)}`);
      }
      keys.add(key);
      entries.push([key, jsonLiteral(property.getInitializerOrThrow())]);
    }
    return Object.fromEntries(entries);
  }
  throw new Error("exampleInput must be a statically readable JSON literal");
}

function namedOperationImportNames(
  source: ReturnType<Project["addSourceFileAtPath"]>,
  importedName: "defineOperation" | "noInput",
): Set<string> {
  const names = new Set<string>();
  for (const declaration of source.getImportDeclarations()) {
    if (
      declaration.isTypeOnly()
      || declaration.getModuleSpecifierValue() !== "@smsunarto/bb-kit/operations"
    ) continue;
    for (const named of declaration.getNamedImports()) {
      if (!named.isTypeOnly() && named.getName() === importedName) {
        names.add(named.getAliasNode()?.getText() ?? named.getName());
      }
    }
  }
  return names;
}

function operationObject(source: ReturnType<Project["addSourceFileAtPath"]>): ObjectLiteralExpression {
  const assignment = source.getExportAssignments().find((value) => !value.isExportEquals());
  const exported = assignment && unwrapExpression(assignment.getExpression());
  if (!exported || !Node.isCallExpression(exported)) {
    throw new Error("default export must call defineOperation({...})");
  }
  const callee = unwrapExpression(exported.getExpression());
  if (
    !Node.isIdentifier(callee)
    || !namedOperationImportNames(source, "defineOperation").has(callee.getText())
  ) {
    throw new Error("default export must call the direct defineOperation import");
  }
  if (exported.getArguments().length !== 1) {
    throw new Error("defineOperation must receive exactly one object literal");
  }
  const argument = exported.getArguments()[0];
  if (!argument || !Node.isExpression(argument)) {
    throw new Error("defineOperation must receive an object literal");
  }
  const object = unwrapExpression(argument);
  if (!Node.isObjectLiteralExpression(object)) {
    throw new Error("defineOperation must receive an object literal");
  }
  return object;
}

function noInputImportNames(source: ReturnType<Project["addSourceFileAtPath"]>): Set<string> {
  return namedOperationImportNames(source, "noInput");
}

function operationMetadata(path: string): Pick<
  DiscoveredOperation,
  "kind" | "risk" | "input" | "metadataError"
> {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const source = project.addSourceFileAtPath(path);
  let object: ObjectLiteralExpression;
  try {
    object = operationObject(source);
  } catch (error) {
    return {
      kind: "unknown",
      risk: null,
      input: null,
      metadataError: error instanceof Error ? error.message : String(error),
    };
  }

  const kindValue = propertyInitializer(object, "kind");
  const kindLiteral = kindValue && Node.isStringLiteral(kindValue)
    ? kindValue.getLiteralValue()
    : null;
  const kind = kindLiteral === "query" || kindLiteral === "command"
    ? kindLiteral
    : "unknown";
  const riskValue = propertyInitializer(object, "risk");
  const riskLiteral = riskValue && Node.isStringLiteral(riskValue)
    ? riskValue.getLiteralValue()
    : null;
  const risk = riskLiteral === "safe"
    || riskLiteral === "mutating"
    || riskLiteral === "destructive"
    ? riskLiteral
    : null;

  try {
    const input = propertyInitializer(object, "input");
    if (!input) throw new Error("operation must declare input");
    const noInputNames = noInputImportNames(source);
    const isNoInput = Node.isIdentifier(input) && noInputNames.has(input.getText());
    const exampleProperty = object.getProperty("exampleInput");
    if (isNoInput) {
      if (exampleProperty) throw new Error("noInput operations must not declare exampleInput");
      return { kind, risk, input: { mode: "none" }, metadataError: null };
    }
    if (!exampleProperty || !Node.isPropertyAssignment(exampleProperty)) {
      throw new Error("required-input operations must declare literal exampleInput");
    }
    return {
      kind,
      risk,
      input: {
        mode: "required",
        example: jsonLiteral(exampleProperty.getInitializerOrThrow()),
      },
      metadataError: null,
    };
  } catch (error) {
    return {
      kind,
      risk,
      input: null,
      metadataError: error instanceof Error ? error.message : String(error),
    };
  }
}

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => /\.(?:ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts"))
    .sort();
}

export function discoverProject(root: string): ProjectInfo {
  const manifest = readManifest(root);
  const serverEntry = manifest.bb?.server;
  if (!serverEntry) throw new Error("package.json is missing bb.server");
  const sourceRoot = dirname(resolve(root, serverEntry));
  const modulesRoot = join(sourceRoot, "modules");
  const lock = readLock(root);
  const modules: DiscoveredModule[] = [];

  if (existsSync(modulesRoot)) {
    for (const name of readdirSync(modulesRoot).sort()) {
      const directory = join(modulesRoot, name);
      if (!statSync(directory).isDirectory()) continue;
      const operations = sourceFiles(join(directory, "operations")).map((entry) => {
        const operationName = entry.replace(/\.(?:ts|tsx)$/, "");
        const identity = `${name}.${operationName}`;
        const file = join(directory, "operations", entry);
        const metadata = operationMetadata(file);
        return {
          identity,
          module: name,
          name: operationName,
          file,
          kind: metadata.kind,
          risk: metadata.risk,
          rpcMethod: lock.operations[identity]?.rpcMethod ?? null,
          input: metadata.input,
          metadataError: metadata.metadataError,
        } satisfies DiscoveredOperation;
      });
      const migrationsDirectory = join(directory, "migrations");
      const migrations = existsSync(migrationsDirectory)
        ? readdirSync(migrationsDirectory).filter((entry) => entry.endsWith(".sql")).sort()
        : [];
      const appPath = join(directory, "app.tsx");
      const appSource = existsSync(appPath) ? readFileSync(appPath, "utf8") : "";
      const surfaces: DiscoveredModule["surfaces"] = [];
      if (appSource.includes("app.slots.navPanel(")) surfaces.push("nav-panel");
      if (appSource.includes("app.slots.threadPanelAction(")) surfaces.push("thread-panel");
      modules.push({
        name,
        directory,
        operations,
        migrations,
        surfaces,
        storage: migrations.length > 0 ? "sqlite" : null,
      });
    }
  }

  return {
    root,
    manifest,
    pluginId: derivePluginId(manifest.name),
    serverEntry,
    appEntry: manifest.bb?.app ?? null,
    modulesRoot,
    modules,
    lock,
  };
}

export function projectPath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

export function toIdentifier(value: string): string {
  const parts = value.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const identifier = parts
    .map((part, index) =>
      index === 0
        ? `${part[0]?.toLowerCase() ?? ""}${part.slice(1)}`
        : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
    )
    .join("");
  if (!/^[a-zA-Z_$]/.test(identifier)) return `_${identifier}`;
  return identifier || "operation";
}

export function defaultWireMethod(identity: string): string {
  return identity.replace(/[.-]/g, "_");
}

export function migrationLockKey(moduleName: string, filename: string): string {
  return `${moduleName}/${filename}`;
}

export function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function migrationCatalogSource(
  moduleName: string,
  directory: string,
  migrations: readonly string[],
): string {
  const identifier = toIdentifier(moduleName);
  const statements = migrations.map((filename) =>
    readFileSync(join(directory, "migrations", filename), "utf8"),
  );
  return [
    "// Generated by bb-kit. Do not edit by hand.",
    `export const ${identifier}Migrations = ${JSON.stringify(statements, null, 2)};`,
    "",
  ].join("\n");
}

export function operationCatalogSource(
  moduleName: string,
  operations: readonly DiscoveredOperation[],
  lock: BbKitLock,
): string {
  const catalog = `${toIdentifier(moduleName)}Operations`;
  const imports: string[] = [];
  const bindings: string[] = [];
  for (const operation of operations) {
    const identityLock = lock.operations[operation.identity];
    if (!identityLock) throw new Error(`${operation.identity} has no identity lock`);
    const identifier = `${toIdentifier(operation.name)}Operation`;
    imports.push(`import ${identifier} from "../operations/${operation.name}.js";`);
    bindings.push(
      `  ${JSON.stringify(toIdentifier(operation.name))}: {\n`
      + `    identity: ${JSON.stringify(operation.identity)},\n`
      + `    wireMethod: ${JSON.stringify(identityLock.rpcMethod)},\n`
      + `    operation: ${identifier},\n`
      + "  },",
    );
  }
  return [
    "// Generated by bb-kit. Do not edit by hand.",
    `import { defineOperationCatalog } from "@smsunarto/bb-kit/operations";`,
    ...imports,
    "",
    `export const ${catalog} = defineOperationCatalog({`,
    ...bindings,
    "});",
    "",
  ].join("\n");
}

export function operationNameFromFile(file: string): string {
  return basename(file).replace(/\.(?:ts|tsx)$/, "");
}
