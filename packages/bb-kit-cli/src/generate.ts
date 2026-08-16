import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { modify, applyEdits } from "jsonc-parser";
import {
  Node,
  Project,
  QuoteKind,
  SyntaxKind,
} from "ts-morph";
import {
  checkSdkDependency,
  compatibility,
} from "./compatibility.js";
import {
  defaultCommandRunner,
  processFailure,
  resolvePathExecutable,
  selectBbCli,
  type CommandRunner,
  type SelectedBbCli,
} from "./process.js";
import {
  defaultWireMethod,
  discoverProject,
  emptyLock,
  fileSha256,
  findProjectRoot,
  migrationCatalogSource,
  migrationLockKey,
  operationCatalogSource,
  readLock,
  readManifest,
  toIdentifier,
  writeLock,
  type PluginManifest,
} from "./project.js";

export type PluginKind = "backend" | "fullstack" | "theme";
export type PanelLocation = "nav" | "thread";

export interface InitOptions {
  kind?: PluginKind;
  packageName?: string;
  syncTypes?: boolean;
  install?: boolean;
  env?: Readonly<NodeJS.ProcessEnv>;
  run?: CommandRunner;
}

const MODULE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MIGRATION_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const FIXTURE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function writeIfMissing(path: string, content: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function editJson(path: string, jsonPath: (string | number)[], value: unknown): void {
  const source = readFileSync(path, "utf8");
  const edits = modify(source, jsonPath, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  writeFileSync(path, applyEdits(source, edits));
}

function manifestTemplate(name: string, kind: PluginKind): PluginManifest {
  const id = name.split("/").at(-1)?.replace(/^bb-plugin-/, "") ?? name;
  const app = kind === "fullstack";
  const theme = kind === "theme";
  return {
    name,
    version: "0.1.0",
    description: `${id} plugin for bb`,
    license: "MIT",
    type: "module",
    files: [
      "dist/",
      "plugin/",
      "README.md",
      "LICENSE",
    ],
    engines: compatibility.engines,
    bb: {
      name: id,
      description: `${id} plugin for bb`,
      branding: { icon: "Puzzle" },
      server: "./plugin/server.ts",
      ...(app ? { app: "./plugin/app.tsx" } : {}),
      ...(theme
        ? {
            themes: [{
              id,
              name: id,
              css: `./plugin/themes/${id}.css`,
            }],
          }
        : {}),
      skills: [],
    },
    scripts: {
      build: "bb-kit build",
      dev: "bb plugin dev .",
      lint: "oxlint",
      typecheck: "tsc --noEmit",
      test: "bun test",
      verify: "bb-kit verify",
      clean: "rm -rf dist",
    },
    dependencies: {},
    devDependencies: {
      "@bb-kit/cli": "^0.1.0",
      "@get-bb/plugin-sdk": compatibility.sdkPackage.version,
      "@types/better-sqlite3": "^7.6.12",
      "@types/node": "^22.0.0",
      "@types/react": "^19.0.0",
      "better-sqlite3": "^12.0.0",
      hono: "^4.11.9",
      oxlint: "^1.77.0",
      typescript: "^7.0.0",
      zod: "^4.4.3",
    },
  };
}

function tsconfigTemplate(): unknown {
  return {
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      lib: ["ES2022", "DOM"],
      types: ["node"],
      paths: {
        "@/*": ["./*"],
      },
      allowImportingTsExtensions: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      useUnknownInCatchVariables: true,
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
      noImplicitReturns: true,
      noEmit: true,
      skipLibCheck: false,
    },
    include: ["plugin", "test"],
  };
}

function runCommand(
  run: CommandRunner,
  file: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<NodeJS.ProcessEnv>,
  label: string,
): void {
  const result = run({ file, args, cwd, env });
  if (result.status !== 0 || result.error) {
    throw new Error(`${label} failed: ${processFailure(result)}`);
  }
}

export function initializeProject(
  target: string,
  options: InitOptions = {},
): string[] {
  const root = resolve(target);
  const kind = options.kind ?? "backend";
  const env = options.env ?? process.env;
  const commandRunner = options.run ?? defaultCommandRunner;
  let selectedBbCli: SelectedBbCli | null = null;
  if (options.syncTypes !== false) {
    let preflightDirectory = dirname(root);
    while (!existsSync(preflightDirectory)) {
      const parent = dirname(preflightDirectory);
      if (parent === preflightDirectory) break;
      preflightDirectory = parent;
    }
    selectedBbCli = selectBbCli(
      preflightDirectory,
      env,
      compatibility.bbCliVersion,
      commandRunner,
    );
  }
  const created: string[] = [];
  mkdirSync(root, { recursive: true });
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) {
    const id = root.split("/").at(-1)?.replace(/^bb-plugin-/, "") ?? "plugin";
    const packageName = options.packageName ?? `bb-plugin-${id}`;
    writeJson(packagePath, manifestTemplate(packageName, kind));
    created.push("package.json");
  }
  const manifest = readManifest(root);
  if (!manifest.bb?.server) {
    throw new Error("existing package.json is not a bb plugin (missing bb.server)");
  }
  const serverPath = resolve(root, manifest.bb.server);
  if (writeIfMissing(
    serverPath,
    `import type { BbPluginApi } from "@get-bb/plugin-sdk";\n\nexport default function plugin(_bb: BbPluginApi): void {}\n`,
  )) created.push(relative(root, serverPath));
  if (manifest.bb.app) {
    const appPath = resolve(root, manifest.bb.app);
    if (writeIfMissing(
      appPath,
      `import { definePluginApp } from "@get-bb/plugin-sdk/app";\n\nexport default definePluginApp((_app) => {});\n`,
    )) created.push(relative(root, appPath));
  }
  if (kind === "theme") {
    const id = manifest.name.split("/").at(-1)?.replace(/^bb-plugin-/, "") ?? "theme";
    const themePath = join(dirname(serverPath), "themes", `${id}.css`);
    if (writeIfMissing(themePath, `/* ${id} bb theme */\n`)) {
      created.push(relative(root, themePath));
    }
  }
  if (writeIfMissing(join(root, "tsconfig.json"), `${JSON.stringify(tsconfigTemplate(), null, 2)}\n`)) {
    created.push("tsconfig.json");
  }
  if (writeIfMissing(join(root, "bb-kit.lock.json"), `${JSON.stringify(emptyLock(), null, 2)}\n`)) {
    created.push("bb-kit.lock.json");
  }
  if (writeIfMissing(join(root, "README.md"), `# ${manifest.name}\n\nA bb plugin built with bb-kit.\n`)) {
    created.push("README.md");
  }
  if (writeIfMissing(
    join(root, "test", "scaffold.test.ts"),
    `import assert from "node:assert/strict";\nimport test from "node:test";\nimport plugin from "../${relative(root, serverPath).replaceAll("\\", "/").replace(/\.ts$/, ".js")}";\n\ntest("plugin scaffold exports its factory", () => {\n  assert.equal(typeof plugin, "function");\n});\n`,
  )) created.push("test/scaffold.test.ts");
  if (writeIfMissing(
    join(root, "AGENTS.md"),
    `# bb-kit plugin conventions\n\n- Organize behavior under \`plugin/modules/<name>/\`.\n- Keep \`contract.ts\` and \`model.ts\` browser-safe.\n- Frontend code must not import \`server.ts\` or \`repository.ts\`.\n- Implement business behavior as headless operations.\n- RPC is authoritative; realtime signals only invalidate queries.\n- Expected domain outcomes use discriminated unions.\n- Create host resources inside the plugin generation.\n- Import \`noInput\` directly for no-input operations; give every other input a literal JSON \`exampleInput\`.\n- Run \`bb-kit check\` while editing and \`bb-kit verify\` before handoff.\n`,
  )) created.push("AGENTS.md");
  const ownLicense = resolve(import.meta.dirname, "../LICENSE");
  if (!existsSync(join(root, "LICENSE")) && existsSync(ownLicense)) {
    cpSync(ownLicense, join(root, "LICENSE"));
    created.push("LICENSE");
  }

  if (selectedBbCli) {
    runCommand(
      commandRunner,
      selectedBbCli.path,
      ["plugin", "types", root],
      root,
      selectedBbCli.env,
      "bb SDK type sync",
    );
    const declarationDiagnostics = checkSdkDependency(root, manifest);
    if (declarationDiagnostics.length > 0) {
      throw new Error(
        `bb SDK type sync produced an incompatible SDK surface: ${declarationDiagnostics
          .map((value) => `${value.file ?? "package.json"}: ${value.message}`)
          .join("; ")}`,
      );
    }
  }
  if (options.install !== false) {
    const bun = resolvePathExecutable("bun", env);
    if (!bun) throw new Error("dependency install failed: bun was not found on PATH");
    runCommand(commandRunner, bun, ["install"], root, env, "dependency install");
  }
  return created;
}

function projectFor(): Project {
  return new Project({
    manipulationSettings: { quoteKind: QuoteKind.Double },
    skipAddingFilesFromTsConfig: true,
  });
}

function assertCompositionRoot(root: string): void {
  const info = discoverProject(root);
  const serverPath = resolve(root, info.serverEntry);
  const project = projectFor();
  const source = project.addSourceFileAtPath(serverPath);
  const functionDeclaration = source.getFunctions().find((fn) => fn.isDefaultExport());
  if (!functionDeclaration?.getBody()) {
    throw new Error(
      `${info.serverEntry} is not a recognized default function composition root`,
    );
  }
  if (functionDeclaration.getParameters().length !== 1) {
    throw new Error(`${info.serverEntry} plugin factory must accept exactly one bb parameter`);
  }
}

function addInstallerToRoot(root: string, moduleName: string, moduleServer: string): void {
  const info = discoverProject(root);
  const serverPath = resolve(root, info.serverEntry);
  const project = projectFor();
  const source = project.addSourceFileAtPath(serverPath);
  const functionDeclaration = source.getFunctions().find((fn) => fn.isDefaultExport());
  if (!functionDeclaration?.getBody()) {
    throw new Error(
      `${info.serverEntry} is not a recognized default function composition root`,
    );
  }
  const installer = `install${toIdentifier(moduleName)[0]?.toUpperCase() ?? ""}${toIdentifier(moduleName).slice(1)}`;
  const specifier = `./${relative(dirname(serverPath), moduleServer).replaceAll("\\", "/").replace(/\.ts$/, ".js")}`;
  const hasImport = source.getImportDeclarations().some((declaration) =>
    declaration.getModuleSpecifierValue() === specifier,
  );
  if (!hasImport) {
    source.addImportDeclaration({ moduleSpecifier: specifier, namedImports: [installer] });
  }
  const body = functionDeclaration.getBodyOrThrow();
  if (!body.getText().includes(`${installer}(`)) {
    functionDeclaration.addStatements(`${installer}(bb);`);
  }
  const parameter = functionDeclaration.getParameters()[0];
  if (parameter?.getName() === "_bb") parameter.rename("bb");
  source.formatText();
  source.saveSync();
}

function moduleServerSource(root: string, moduleName: string): {
  source: ReturnType<Project["addSourceFileAtPath"]>;
  installer: NonNullable<ReturnType<ReturnType<Project["addSourceFileAtPath"]>["getFunction"]>>;
} {
  const info = discoverProject(root);
  const module = info.modules.find((candidate) => candidate.name === moduleName);
  if (!module) throw new Error(`unknown module "${moduleName}"`);
  const names = moduleNames(moduleName);
  const serverPath = join(module.directory, "server.ts");
  const project = projectFor();
  const source = project.addSourceFileAtPath(serverPath);
  const installer = source.getFunction(names.installer);
  if (!installer?.getBody()) {
    throw new Error(`${projectPath(root, serverPath)} is not a recognized module installer`);
  }
  return { source, installer };
}

function assertServiceRoot(root: string, moduleName: string): void {
  const info = discoverProject(root);
  const module = info.modules.find((candidate) => candidate.name === moduleName);
  if (!module) throw new Error(`unknown module "${moduleName}"`);
  const names = moduleNames(moduleName);
  const servicePath = join(module.directory, "service.ts");
  const project = projectFor();
  const source = project.addSourceFileAtPath(servicePath);
  const initializer = source.getVariableDeclaration(names.service)?.getInitializer();
  const object = initializer?.isKind(SyntaxKind.SatisfiesExpression)
    ? initializer.getExpressionIfKind(SyntaxKind.ObjectLiteralExpression)
    : initializer?.asKind(SyntaxKind.ObjectLiteralExpression);
  if (!object) {
    throw new Error(`${projectPath(root, servicePath)} is not a recognized service object`);
  }
}

function addMigrationsToModuleServer(root: string, moduleName: string): void {
  const { source, installer } = moduleServerSource(root, moduleName);
  const identifier = toIdentifier(moduleName);
  const migrations = `${identifier}Migrations`;
  const database = `${identifier}Database`;
  const specifier = "./generated/migrations.js";
  const hasImport = source.getImportDeclarations().some((declaration) =>
    declaration.getModuleSpecifierValue() === specifier
    && declaration.getNamedImports().some((namedImport) => namedImport.getName() === migrations),
  );
  if (!hasImport) {
    source.addImportDeclaration({ moduleSpecifier: specifier, namedImports: [migrations] });
  }
  const body = installer.getBodyText() ?? "";
  if (!body.includes(`bb.storage.migrate(${database}, ${migrations})`)) {
    installer.insertStatements(
      0,
      `const ${database} = bb.storage.database();\nbb.storage.migrate(${database}, ${migrations});`,
    );
  }
  source.formatText();
  source.saveSync();
}

function assertAppCompositionRoot(root: string): void {
  const info = discoverProject(root);
  if (!info.appEntry) {
    throw new Error("plugin has no bb.app entry; panels require a fullstack plugin");
  }
  const appPath = resolve(root, info.appEntry);
  const project = projectFor();
  const source = project.addSourceFileAtPath(appPath);
  const assignment = source.getExportAssignments().find((value) => !value.isExportEquals());
  const call = assignment?.getExpressionIfKind(SyntaxKind.CallExpression);
  const callback = call?.getArguments()[0];
  if (
    !callback
    || (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback))
    || !callback.getBody().isKind(SyntaxKind.Block)
    || callback.getParameters().length !== 1
  ) {
    throw new Error(`${info.appEntry} is not a recognized definePluginApp composition root`);
  }
}

function addAppInstallerToRoot(root: string, moduleName: string, moduleApp: string): void {
  assertAppCompositionRoot(root);
  const info = discoverProject(root);
  const appPath = resolve(root, info.appEntry as string);
  const project = projectFor();
  const source = project.addSourceFileAtPath(appPath);
  const assignment = source.getExportAssignments().find((value) => !value.isExportEquals());
  const call = assignment?.getExpressionIfKind(SyntaxKind.CallExpression);
  const callback = call?.getArguments()[0];
  if (!callback || (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback))) {
    throw new Error(`${info.appEntry} is not a recognized definePluginApp composition root`);
  }
  const names = moduleNames(moduleName);
  const register = `register${names.installer.slice("install".length)}App`;
  const specifier = `./${relative(dirname(appPath), moduleApp).replaceAll("\\", "/").replace(/\.tsx$/, ".js")}`;
  const hasImport = source.getImportDeclarations().some((declaration) =>
    declaration.getModuleSpecifierValue() === specifier,
  );
  if (!hasImport) {
    source.addImportDeclaration({ moduleSpecifier: specifier, namedImports: [register] });
  }
  const body = callback.getBody();
  if (!body.getText().includes(`${register}(`)) callback.addStatements(`${register}(app);`);
  const parameter = callback.getParameters()[0];
  if (parameter?.getName() === "_app") parameter.rename("app");
  source.formatText();
  source.saveSync();
}

function moduleNames(moduleName: string): {
  installer: string;
  catalog: string;
  service: string;
} {
  const identifier = toIdentifier(moduleName);
  const pascal = `${identifier[0]?.toUpperCase() ?? ""}${identifier.slice(1)}`;
  return {
    installer: `install${pascal}`,
    catalog: `${identifier}Operations`,
    service: `${identifier}Service`,
  };
}

export function addModule(rootOrChild: string, moduleName: string): string[] {
  if (!MODULE_PATTERN.test(moduleName)) {
    throw new Error("module name must be lowercase kebab-case");
  }
  const root = findProjectRoot(rootOrChild);
  assertCompositionRoot(root);
  const info = discoverProject(root);
  const directory = join(info.modulesRoot, moduleName);
  const names = moduleNames(moduleName);
  const created: string[] = [];
  mkdirSync(join(directory, "operations"), { recursive: true });
  mkdirSync(join(directory, "generated"), { recursive: true });
  if (writeIfMissing(
    join(directory, "generated", "operations.ts"),
    operationCatalogSource(moduleName, [], info.lock),
  )) created.push(`${moduleName}/generated/operations.ts`);
  if (writeIfMissing(
    join(directory, "service.ts"),
    `import type { OperationHandlersFor } from "@bb-kit/core/operations";\nimport { ${names.catalog} } from "./generated/operations.js";\n\nexport const ${names.service} = {} satisfies OperationHandlersFor<typeof ${names.catalog}>;\n`,
  )) created.push(`${moduleName}/service.ts`);
  const moduleServer = join(directory, "server.ts");
  if (writeIfMissing(
    moduleServer,
    `import type { BbPluginApi } from "@get-bb/plugin-sdk";\nimport { registerOperations } from "@bb-kit/core/operations";\nimport { ${names.catalog} } from "./generated/operations.js";\nimport { ${names.service} } from "./service.js";\n\nexport function ${names.installer}(bb: BbPluginApi): void {\n  registerOperations(bb, ${names.catalog}, ${names.service});\n}\n`,
  )) created.push(`${moduleName}/server.ts`);
  addInstallerToRoot(root, moduleName, moduleServer);
  editJson(join(root, "package.json"), ["dependencies", "@bb-kit/core"], "^0.1.0");
  editJson(join(root, "package.json"), ["dependencies", "zod"], "^4.4.3");
  editJson(join(root, "package.json"), ["devDependencies", "zod"], undefined);
  return created;
}

function regenerateCatalog(root: string, moduleName: string): void {
  const info = discoverProject(root);
  const module = info.modules.find((candidate) => candidate.name === moduleName);
  if (!module) throw new Error(`unknown module "${moduleName}"`);
  writeFileSync(
    join(module.directory, "generated", "operations.ts"),
    operationCatalogSource(moduleName, module.operations, info.lock),
  );
}

function addServiceHandler(root: string, moduleName: string, operationName: string): void {
  const info = discoverProject(root);
  const module = info.modules.find((candidate) => candidate.name === moduleName);
  if (!module) throw new Error(`unknown module "${moduleName}"`);
  const names = moduleNames(moduleName);
  const servicePath = join(module.directory, "service.ts");
  const project = projectFor();
  const source = project.addSourceFileAtPath(servicePath);
  const declaration = source.getVariableDeclaration(names.service);
  const declarationInitializer = declaration?.getInitializer();
  const initializer = declarationInitializer?.isKind(SyntaxKind.SatisfiesExpression)
    ? declarationInitializer.getExpressionIfKind(SyntaxKind.ObjectLiteralExpression)
    : declarationInitializer?.asKind(SyntaxKind.ObjectLiteralExpression);
  if (!initializer) throw new Error(`${projectPath(root, servicePath)} is not a recognized service object`);
  const key = toIdentifier(operationName);
  if (!initializer.getProperty(key)) {
    initializer.addPropertyAssignment({
      name: key,
      initializer: `async (_input) => {\n  throw new Error(${JSON.stringify(`TODO: implement ${moduleName}.${operationName}`)});\n}`,
    });
  }
  source.formatText();
  source.saveSync();
}

function projectPath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

export function addOperation(
  rootOrChild: string,
  identity: string,
  kind: "query" | "command",
  risk: "safe" | "mutating" | "destructive" = "mutating",
): string[] {
  const [moduleName, operationName, ...extra] = identity.split(".");
  if (!moduleName || !operationName || extra.length > 0) {
    throw new Error("operation identity must be module.operation");
  }
  if (!MODULE_PATTERN.test(moduleName) || !MODULE_PATTERN.test(operationName)) {
    throw new Error("operation identity must use lowercase kebab-case segments");
  }
  const root = findProjectRoot(rootOrChild);
  let info = discoverProject(root);
  const identityLock = readLock(root);
  const proposedRpcMethod = identityLock.operations[identity]?.rpcMethod
    ?? defaultWireMethod(identity);
  const identityCollision = Object.entries(identityLock.operations).find(
    ([otherIdentity, value]) =>
      otherIdentity !== identity && value.rpcMethod === proposedRpcMethod,
  );
  if (identityCollision) {
    throw new Error(
      `generated RPC method "${proposedRpcMethod}" collides with ${identityCollision[0]}; choose an explicit mapping`,
    );
  }
  let module = info.modules.find((candidate) => candidate.name === moduleName);
  if (!module) {
    addModule(root, moduleName);
    info = discoverProject(root);
    module = info.modules.find((candidate) => candidate.name === moduleName);
  }
  if (!module) throw new Error(`could not create module "${moduleName}"`);
  assertServiceRoot(root, moduleName);
  const operationPath = join(module.directory, "operations", `${operationName}.ts`);
  const lock = readLock(root);
  const rpcMethod = lock.operations[identity]?.rpcMethod ?? proposedRpcMethod;
  const created: string[] = [];
  if (existsSync(operationPath)) {
    const existing = module.operations.find((operation) => operation.identity === identity);
    if (existing?.kind !== kind) {
      throw new Error(
        `${identity} already exists as ${existing?.kind ?? "an unrecognized operation"}, not ${kind}`,
      );
    }
  } else {
    const commandFields = kind === "command" ? `\n  risk: ${JSON.stringify(risk)},` : "";
    writeFileSync(
      operationPath,
      `import { defineOperation, noInput } from "@bb-kit/core/operations";\nimport { z } from "zod";\n\nexport default defineOperation({\n  kind: ${JSON.stringify(kind)},${commandFields}\n  input: noInput,\n  output: z.object({}).strict(),\n});\n`,
    );
    created.push(projectPath(root, operationPath));
  }
  lock.operations[identity] = { rpcMethod };
  writeLock(root, lock);
  regenerateCatalog(root, moduleName);
  addServiceHandler(root, moduleName, operationName);
  return created;
}

export function addFixture(
  rootOrChild: string,
  identity: string,
  fixtureName: string,
): string[] {
  if (!FIXTURE_PATTERN.test(fixtureName)) {
    throw new Error("fixture name must be lowercase kebab-case");
  }
  const root = findProjectRoot(rootOrChild);
  const info = discoverProject(root);
  const operation = info.modules
    .flatMap((module) => module.operations)
    .find((candidate) => candidate.identity === identity);
  if (!operation) {
    throw new Error(`unknown operation "${identity}"; add the operation before its fixture`);
  }
  if (operation.metadataError !== null || operation.input === null) {
    throw new Error(
      `${identity} has invalid input metadata: ${operation.metadataError ?? "input state is missing"}`,
    );
  }
  const path = join(root, "fixtures", operation.module, `${fixtureName}.json`);
  const invoke = operation.input.mode === "none"
    ? { operation: identity }
    : { operation: identity, input: operation.input.example };
  const content = `${JSON.stringify({
    name: `${identity}-${fixtureName}`,
    invoke,
    expect: {},
  }, null, 2)}\n`;
  return writeIfMissing(path, content) ? [projectPath(root, path)] : [];
}

export function addMigration(
  rootOrChild: string,
  moduleName: string,
  migrationName: string,
): string[] {
  if (!MODULE_PATTERN.test(moduleName) || !MIGRATION_PATTERN.test(migrationName)) {
    throw new Error("module and migration names must be lowercase kebab-case");
  }
  const root = findProjectRoot(rootOrChild);
  let info = discoverProject(root);
  let module = info.modules.find((candidate) => candidate.name === moduleName);
  if (!module) {
    addModule(root, moduleName);
    info = discoverProject(root);
    module = info.modules.find((candidate) => candidate.name === moduleName);
  }
  if (!module) throw new Error(`could not create module "${moduleName}"`);
  moduleServerSource(root, moduleName);

  const existing = module.migrations.find((filename) =>
    filename.endsWith(`-${migrationName}.sql`),
  );
  const created: string[] = [];
  let filename = existing;
  if (!filename) {
    const malformed = module.migrations.find((entry) => !/^\d{3}-[a-z0-9][a-z0-9-]*\.sql$/.test(entry));
    if (malformed) {
      throw new Error(`cannot append after malformed migration "${malformed}"`);
    }
    for (const [index, entry] of module.migrations.entries()) {
      const sequence = Number(entry.slice(0, 3));
      if (sequence !== index + 1) {
        throw new Error(`cannot append after non-contiguous migration "${entry}"`);
      }
    }
    const sequence = module.migrations.length + 1;
    filename = `${String(sequence).padStart(3, "0")}-${migrationName}.sql`;
    const path = join(module.directory, "migrations", filename);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `-- ${moduleName}: ${migrationName}\n`);
    created.push(projectPath(root, path));
    module.migrations.push(filename);
    module.migrations.sort();
  }

  const lock = readLock(root);
  const migrationPath = join(module.directory, "migrations", filename);
  const lockKey = migrationLockKey(moduleName, filename);
  const sha256 = fileSha256(migrationPath);
  const previous = lock.migrations[lockKey];
  if (previous && previous.sha256 !== sha256) {
    throw new Error(`locked migration "${lockKey}" was modified; append a new migration instead`);
  }
  lock.migrations[lockKey] = { sha256 };
  writeLock(root, lock);
  mkdirSync(join(module.directory, "generated"), { recursive: true });
  writeFileSync(
    join(module.directory, "generated", "migrations.ts"),
    migrationCatalogSource(moduleName, module.directory, module.migrations),
  );
  addMigrationsToModuleServer(root, moduleName);
  return created;
}

export function addPanel(
  rootOrChild: string,
  moduleName: string,
  location: PanelLocation,
): string[] {
  if (!MODULE_PATTERN.test(moduleName)) {
    throw new Error("module name must be lowercase kebab-case");
  }
  const root = findProjectRoot(rootOrChild);
  let info = discoverProject(root);
  if (!info.appEntry) {
    throw new Error("plugin has no bb.app entry; panels require a fullstack plugin");
  }
  assertAppCompositionRoot(root);
  let module = info.modules.find((candidate) => candidate.name === moduleName);
  if (!module) {
    addModule(root, moduleName);
    info = discoverProject(root);
    module = info.modules.find((candidate) => candidate.name === moduleName);
  }
  if (!module) throw new Error(`could not create module "${moduleName}"`);

  const names = moduleNames(moduleName);
  const pascal = names.installer.slice("install".length);
  const panelName = `${pascal}Panel`;
  const title = moduleName
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
  const panelPath = join(module.directory, "panel.tsx");
  const moduleApp = join(module.directory, "app.tsx");
  const props = location === "nav" ? "PluginNavPanelProps" : "PluginThreadPanelProps";
  const registration = location === "nav"
    ? `app.slots.navPanel({\n    id: ${JSON.stringify(moduleName)},\n    title: ${JSON.stringify(title)},\n    icon: "Puzzle",\n    path: ${JSON.stringify(moduleName)},\n    component: ${panelName},\n  });`
    : `app.slots.threadPanelAction({\n    id: ${JSON.stringify(moduleName)},\n    title: ${JSON.stringify(title)},\n    icon: "Puzzle",\n    component: ${panelName},\n  });`;
  const created: string[] = [];
  if (existsSync(moduleApp)) {
    const source = readFileSync(moduleApp, "utf8");
    const expectedSlot = location === "nav" ? "app.slots.navPanel(" : "app.slots.threadPanelAction(";
    if (!source.includes(expectedSlot)) {
      throw new Error(
        `${projectPath(root, moduleApp)} already registers a different panel location; refusing to replace it`,
      );
    }
  }
  if (writeIfMissing(
    panelPath,
    `import type { ${props} } from "@get-bb/plugin-sdk/app";\nimport { PluginQueryBoundary } from "@bb-kit/core/query";\n\nexport function ${panelName}(_props: ${props}) {\n  return (\n    <PluginQueryBoundary>\n      <main>\n        <h1>${title}</h1>\n        <p>TODO: connect this panel to the module's operations.</p>\n      </main>\n    </PluginQueryBoundary>\n  );\n}\n`,
  )) created.push(projectPath(root, panelPath));
  if (!existsSync(moduleApp)) {
    writeFileSync(
      moduleApp,
      `import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";\nimport { ${panelName} } from "./panel.js";\n\nexport function register${pascal}App(app: PluginAppBuilder): void {\n  ${registration}\n}\n`,
    );
    created.push(projectPath(root, moduleApp));
  }
  addAppInstallerToRoot(root, moduleName, moduleApp);
  editJson(join(root, "package.json"), ["dependencies", "@bb-kit/core"], "^0.1.0");
  editJson(
    join(root, "package.json"),
    ["dependencies", "@tanstack/react-query"],
    "^5.101.4",
  );
  return created;
}
