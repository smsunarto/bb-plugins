import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Node, Project } from "ts-morph";
import {
  OPERATION_IDENTITY_PATTERN,
  RPC_METHOD_PATTERN,
  discoverProject,
  fileSha256,
  migrationCatalogSource,
  migrationLockKey,
  operationCatalogSource,
  projectPath,
  type ProjectInfo,
} from "./project.js";

export interface Diagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  file?: string;
  hint: string;
}

function diagnostic(
  code: string,
  message: string,
  hint: string,
  file?: string,
): Diagnostic {
  return {
    code,
    severity: "error",
    message,
    hint,
    ...(file === undefined ? {} : { file }),
  };
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (/\.(?:ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

function resolveLocalImport(
  root: string,
  from: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null;
  const base = specifier.startsWith("@/")
    ? resolve(root, specifier.slice(2))
    : resolve(dirname(from), specifier);
  const sourceBase = base.endsWith(".js")
    ? base.slice(0, -3)
    : base.endsWith(".jsx") ? base.slice(0, -4) : base;
  return [
    base,
    `${sourceBase}.ts`,
    `${sourceBase}.tsx`,
    join(sourceBase, "index.ts"),
    join(sourceBase, "index.tsx"),
  ].find((candidate) => files.has(candidate)) ?? null;
}

function owningModule(info: ProjectInfo, path: string): string | null {
  const value = relative(info.modulesRoot, path).replaceAll("\\", "/");
  if (value === "" || value === ".." || value.startsWith("../")) return null;
  return value.split("/")[0] ?? null;
}

function runtimePackage(specifier: string): string | null {
  if (
    specifier.startsWith(".")
    || specifier.startsWith("@/")
    || specifier.startsWith("node:")
  ) return null;
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : specifier;
  }
  return specifier.split("/")[0] ?? specifier;
}

function isTypeOnlyImport(
  declaration: ReturnType<ReturnType<Project["addSourceFileAtPath"]>["getImportDeclarations"]>[number],
): boolean {
  if (declaration.isTypeOnly()) return true;
  if (declaration.getDefaultImport() || declaration.getNamespaceImport()) return false;
  const named = declaration.getNamedImports();
  return named.length > 0 && named.every((value) => value.isTypeOnly());
}

function isHostRuntimePackage(name: string): boolean {
  return name === "@bb/plugin-sdk"
    || name === "react"
    || name === "react-dom"
    || name === "sonner"
    || name === "vaul"
    || name.startsWith("@radix-ui/");
}

function checkManifest(info: ProjectInfo): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!/(?:^|\/)bb-plugin-[^/]+$/.test(info.manifest.name)) {
    diagnostics.push(diagnostic(
      "BBK001",
      `package name "${info.manifest.name}" does not contain bb-plugin-<id>`,
      "Rename the package so bb derives a stable plugin id.",
      "package.json",
    ));
  }
  for (const [field, entry] of [
    ["bb.server", info.serverEntry],
    ["bb.app", info.appEntry],
  ] as const) {
    if (entry === null) continue;
    if (/(?:^|\/)dist\//.test(entry)) {
      diagnostics.push(diagnostic(
        "BBK002",
        `${field} points at generated output "${entry}"`,
        "Point the manifest at shipped source; bb uses it as the SDK fallback.",
        "package.json",
      ));
    }
    if (!existsSync(resolve(info.root, entry))) {
      diagnostics.push(diagnostic(
        "BBK003",
        `${field} target "${entry}" does not exist`,
        "Restore the source entry or correct the manifest path.",
        "package.json",
      ));
    }
  }
  const bbRange = info.manifest.engines?.bb;
  if (
    bbRange !== ">=0.36.0 <0.37.0"
    && bbRange !== ">=0.36 <0.37"
    && bbRange !== "^0.36.0"
    && bbRange !== "^0.36"
  ) {
    diagnostics.push(diagnostic(
      "BBK004",
      `engines.bb ${JSON.stringify(bbRange)} is outside bb-kit's tested 0.36.x line`,
      "Set engines.bb to \">=0.36.0 <0.37.0\" or verify and release a new compatibility line.",
      "package.json",
    ));
  }
  if (info.manifest.engines?.bbPluginSdk !== "^0.4.1") {
    diagnostics.push(diagnostic(
      "BBK005",
      `engines.bbPluginSdk ${JSON.stringify(info.manifest.engines?.bbPluginSdk)} does not match protocol 0.4.1`,
      "Set engines.bbPluginSdk to \"^0.4.1\" and refresh generated SDK declarations with the matching bb CLI.",
      "package.json",
    ));
  }
  if (info.manifest.license !== "MIT") {
    diagnostics.push(diagnostic(
      "BBK006",
      `package license ${JSON.stringify(info.manifest.license)} is not the framework default`,
      "Declare MIT, or document and teach bb-kit the intended compound license before publishing.",
      "package.json",
    ));
  }
  if (!Array.isArray(info.manifest.files)) {
    diagnostics.push(diagnostic(
      "BBK007",
      "package.json has no files allowlist",
      "Declare the exact source, generated output, license, and documentation shipped by the plugin.",
      "package.json",
    ));
  }
  return diagnostics;
}

function checkFrameworkDependencies(info: ProjectInfo): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (info.modules.length === 0) return diagnostics;
  const dependencies = info.manifest.dependencies ?? {};
  if (!dependencies["@bb-kit/core"]) {
    diagnostics.push(diagnostic(
      "BBK008",
      "module source uses bb-kit but it is not a runtime dependency",
      "Add @bb-kit/core to dependencies so bb's source fallback can resolve it.",
      "package.json",
    ));
  }
  if (
    info.modules.some((module) => module.operations.length > 0)
    && !dependencies.zod
  ) {
    diagnostics.push(diagnostic(
      "BBK009",
      "operation contracts use zod but it is not a runtime dependency",
      "Add zod to dependencies so bb's source fallback can load operation schemas.",
      "package.json",
    ));
  }
  if (
    info.modules.some((module) => module.surfaces.length > 0)
    && !dependencies["@tanstack/react-query"]
  ) {
    diagnostics.push(diagnostic(
      "BBK010",
      "panel source uses TanStack Query through bb-kit but it is not a runtime dependency",
      "Add @tanstack/react-query to dependencies for the frontend source fallback.",
      "package.json",
    ));
  }
  return diagnostics;
}

function checkOperations(info: ProjectInfo): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const discovered = new Set<string>();
  const methods = new Map<string, string>();
  for (const module of info.modules) {
    for (const operation of module.operations) {
      discovered.add(operation.identity);
      const file = projectPath(info.root, operation.file);
      if (!OPERATION_IDENTITY_PATTERN.test(operation.identity)) {
        diagnostics.push(diagnostic(
          "BBK201",
          `operation identity "${operation.identity}" is invalid`,
          "Use lowercase kebab-case module and operation filenames.",
          file,
        ));
      }
      if (operation.kind === "unknown") {
        diagnostics.push(diagnostic(
          "BBK202",
          `cannot discover the kind of ${operation.identity}`,
          "Declare kind: \"query\" or kind: \"command\" in defineOperation().",
          file,
        ));
      }
      if (operation.kind === "command" && operation.risk === null) {
        diagnostics.push(diagnostic(
          "BBK207",
          `${operation.identity} does not declare a recognized command risk`,
          "Declare risk: \"safe\", \"mutating\", or \"destructive\".",
          file,
        ));
      }
      if (operation.rpcMethod === null) {
        diagnostics.push(diagnostic(
          "BBK203",
          `${operation.identity} has no locked RPC method`,
          "Regenerate the operation with bb-kit add operation.",
          "bb-kit.lock.json",
        ));
        continue;
      }
      if (!RPC_METHOD_PATTERN.test(operation.rpcMethod)) {
        diagnostics.push(diagnostic(
          "BBK204",
          `RPC method "${operation.rpcMethod}" is not accepted by bb`,
          "Use only letters, numbers, underscores, and hyphens.",
          "bb-kit.lock.json",
        ));
      }
      const previous = methods.get(operation.rpcMethod);
      if (previous !== undefined) {
        diagnostics.push(diagnostic(
          "BBK205",
          `${operation.identity} and ${previous} share RPC method "${operation.rpcMethod}"`,
          "Assign one operation a different explicit wire method.",
          "bb-kit.lock.json",
        ));
      } else methods.set(operation.rpcMethod, operation.identity);
    }
    if (module.operations.every((operation) => operation.rpcMethod !== null)) {
      const catalogPath = join(module.directory, "generated", "operations.ts");
      const expected = operationCatalogSource(module.name, module.operations, info.lock);
      if (!existsSync(catalogPath) || readFileSync(catalogPath, "utf8") !== expected) {
        diagnostics.push(diagnostic(
          "BBK208",
          `${module.name} operation catalog is missing or stale`,
          `Run bb-kit add operation for the module's operations to regenerate it.`,
          projectPath(info.root, catalogPath),
        ));
      }
    }
  }
  for (const identity of Object.keys(info.lock.operations)) {
    if (!discovered.has(identity)) {
      diagnostics.push(diagnostic(
        "BBK206",
        `locked operation "${identity}" has no source file`,
        "Restore the operation, use bb-kit move, or explicitly remove its compatibility entry.",
        "bb-kit.lock.json",
      ));
    }
  }
  return diagnostics;
}

function checkMigrations(info: ProjectInfo): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const discovered = new Set<string>();
  for (const module of info.modules) {
    let catalogComparable = module.migrations.length > 0;
    for (const [index, filename] of module.migrations.entries()) {
      const path = join(module.directory, "migrations", filename);
      const file = projectPath(info.root, path);
      if (!/^\d{3}-[a-z0-9][a-z0-9-]*\.sql$/.test(filename)) {
        diagnostics.push(diagnostic(
          "BBK301",
          `migration filename "${filename}" is invalid`,
          "Use a three-digit sequence and lowercase kebab-case name, for example 001-initial.sql.",
          file,
        ));
        catalogComparable = false;
        continue;
      }
      const sequence = Number(filename.slice(0, 3));
      if (sequence !== index + 1) {
        diagnostics.push(diagnostic(
          "BBK302",
          `${module.name} migrations are not contiguous at "${filename}"`,
          "Restore the missing migration; shipped migration order is append-only.",
          file,
        ));
      }
      const key = migrationLockKey(module.name, filename);
      discovered.add(key);
      const locked = info.lock.migrations[key];
      if (!locked) {
        diagnostics.push(diagnostic(
          "BBK303",
          `migration "${key}" is not locked`,
          "Create migrations with bb-kit add migration so their immutable hash is recorded.",
          "bb-kit.lock.json",
        ));
      } else if (locked.sha256 !== fileSha256(path)) {
        diagnostics.push(diagnostic(
          "BBK304",
          `locked migration "${key}" was modified`,
          "Restore the original statement and append a new migration instead.",
          file,
        ));
      }
    }
    if (catalogComparable) {
      const catalogPath = join(module.directory, "generated", "migrations.ts");
      const expected = migrationCatalogSource(
        module.name,
        module.directory,
        module.migrations,
      );
      if (!existsSync(catalogPath) || readFileSync(catalogPath, "utf8") !== expected) {
        diagnostics.push(diagnostic(
          "BBK305",
          `${module.name} migration catalog is missing or stale`,
          "Run bb-kit add migration with the latest migration name to regenerate it.",
          projectPath(info.root, catalogPath),
        ));
      }
    }
  }
  for (const key of Object.keys(info.lock.migrations)) {
    if (!discovered.has(key)) {
      diagnostics.push(diagnostic(
        "BBK306",
        `locked migration "${key}" has no SQL file`,
        "Restore the append-only migration file.",
        "bb-kit.lock.json",
      ));
    }
  }
  return diagnostics;
}

function checkImports(info: ProjectInfo): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const sourceRoot = dirname(resolve(info.root, info.serverEntry));
  const files = walk(sourceRoot);
  const fileSet = new Set(files);
  const graph = new Map<string, string[]>();
  const project = new Project({
    compilerOptions: { allowJs: false },
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths(files);
  for (const source of project.getSourceFiles()) {
    const path = source.getFilePath();
    const base = path.split("/").at(-1) ?? path;
    const frontend = /^(?:app|panel|queries)\.tsx?$/.test(base);
    const pure = /^(?:contract|model)\.ts$/.test(base);
    const dependencies: string[] = [];
    for (const statement of [
      ...source.getVariableStatements(),
      ...source.getStatements().filter(Node.isExpressionStatement),
    ]) {
      if (
        /\b(?:setInterval|setTimeout|spawn|execFile|exec|fork)\s*\(|new\s+(?:WebSocket|Worker|Database)\s*\(|\.storage\.(?:database|kv)\s*\(/.test(
          statement.getText(),
        )
      ) {
        diagnostics.push(diagnostic(
          "BBK108",
          `${base} creates a generation resource at module scope`,
          "Create timers, processes, sockets, and storage handles inside the plugin factory or module installer and register disposal immediately.",
          projectPath(info.root, path),
        ));
      }
    }
    for (const declaration of source.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      const packageName = runtimePackage(specifier);
      if (
        packageName
        && !isTypeOnlyImport(declaration)
        && !isHostRuntimePackage(packageName)
        && !info.manifest.dependencies?.[packageName]
        && packageName !== "@bb-kit/core"
        && packageName !== "zod"
        && packageName !== "@tanstack/react-query"
      ) {
        diagnostics.push(diagnostic(
          "BBK109",
          `${base} runtime-imports "${packageName}" but it is not in dependencies`,
          "Move the package from devDependencies to dependencies so bb's source fallback can resolve it.",
          projectPath(info.root, path),
        ));
      }
      const target = resolveLocalImport(info.root, path, specifier, fileSet);
      if (target) {
        dependencies.push(target);
        const sourceModule = owningModule(info, path);
        const targetModule = owningModule(info, target);
        if (
          sourceModule !== null
          && targetModule !== null
          && sourceModule !== targetModule
        ) {
          diagnostics.push(diagnostic(
            "BBK106",
            `${sourceModule} imports ${targetModule} internals through "${specifier}"`,
            "Collaborate through an explicit operation or promote a genuinely shared pure contract.",
            projectPath(info.root, path),
          ));
        }
      }
      if (
        frontend
        && (specifier.startsWith("node:")
          || /(?:^|\/)(?:server|repository)(?:\.js|\.ts)?$/.test(specifier))
      ) {
        diagnostics.push(diagnostic(
          "BBK104",
          `${base} imports server-only module "${specifier}"`,
          "Move shared contracts to contract.ts and keep persistence behind RPC.",
          projectPath(info.root, path),
        ));
      }
      if (
        pure
        && (specifier.startsWith("node:")
          || specifier === "@bb/plugin-sdk"
          || specifier === "@bb/plugin-sdk/app"
          || specifier === "react"
          || /(?:^|\/)(?:server|repository)(?:\.js|\.ts)?$/.test(specifier))
      ) {
        diagnostics.push(diagnostic(
          "BBK105",
          `${base} imports infrastructure module "${specifier}"`,
          "Keep contracts and models browser-safe and infrastructure-free.",
          projectPath(info.root, path),
        ));
      }
    }
    graph.set(path, dependencies);
  }
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycles = new Set<string>();
  const visit = (path: string): void => {
    if (state.get(path) === "visited") return;
    if (state.get(path) === "visiting") {
      const start = stack.indexOf(path);
      if (start >= 0) {
        const cycle = stack.slice(start);
        const identity = [...cycle].sort().join("|");
        if (!cycles.has(identity)) {
          cycles.add(identity);
          diagnostics.push(diagnostic(
            "BBK107",
            `import cycle: ${[...cycle, path]
              .map((entry) => projectPath(info.root, entry))
              .join(" → ")}`,
            "Move the shared rule toward the module model or invert the dependency through an explicit interface.",
            projectPath(info.root, path),
          ));
        }
      }
      return;
    }
    state.set(path, "visiting");
    stack.push(path);
    for (const dependency of graph.get(path) ?? []) visit(dependency);
    stack.pop();
    state.set(path, "visited");
  };
  for (const path of graph.keys()) visit(path);
  return diagnostics;
}

export function checkProject(root: string): Diagnostic[] {
  let info: ProjectInfo;
  try {
    info = discoverProject(root);
  } catch (error) {
    return [diagnostic(
      "BBK000",
      error instanceof Error ? error.message : String(error),
      "Fix package.json and bb-kit.lock.json before running other bb-kit commands.",
    )];
  }
  return [
    ...checkManifest(info),
    ...checkFrameworkDependencies(info),
    ...checkOperations(info),
    ...checkMigrations(info),
    ...checkImports(info),
  ].sort((left, right) =>
    `${left.file ?? ""}:${left.code}`.localeCompare(`${right.file ?? ""}:${right.code}`),
  );
}

export function formatDiagnostic(value: Diagnostic): string {
  const location = value.file ? `${value.file}: ` : "";
  return `${value.code} ${location}${value.message}\n  ${value.hint}`;
}
