import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";

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
}

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

function operationMetadata(path: string): Pick<DiscoveredOperation, "kind" | "risk"> {
  const source = readFileSync(path, "utf8");
  if (/kind\s*:\s*["']query["']/.test(source)) {
    return { kind: "query", risk: null };
  }
  if (/kind\s*:\s*["']command["']/.test(source)) {
    const risk = /risk\s*:\s*["'](safe|mutating|destructive)["']/.exec(source)?.[1];
    return {
      kind: "command",
      risk: risk === "safe" || risk === "mutating" || risk === "destructive"
        ? risk
        : null,
    };
  }
  return { kind: "unknown", risk: null };
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
    `import { defineOperationCatalog } from "@bb-kit/core/operations";`,
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
