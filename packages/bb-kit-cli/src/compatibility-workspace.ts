import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { Node, Project } from "ts-morph";
import type { Diagnostic } from "./check.js";
import {
  checkBuildMetadata,
  checkSdkDeclarations,
  compatibility,
  type CompatibilityContract,
} from "./compatibility.js";
import {
  defaultCommandRunner,
  inspectBbCli,
  ProcessError,
  processFailure,
  type CommandRunner,
  type SelectedBbCli,
} from "./process.js";
import type { PluginManifest } from "./project.js";

const CONTRACT_PATH = "packages/bb-kit-cli/src/compatibility-contract.ts";

interface WorkspacePlugin {
  readonly directory: string;
  readonly root: string;
  readonly manifest: PluginManifest;
}

interface ProbedCompatibility {
  readonly contract: CompatibilityContract;
  readonly declarations: {
    readonly server: string;
    readonly app: string;
  };
}

export interface CompatibilityCommandOptions {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly run?: CommandRunner;
}

export interface CompatibilityInspection {
  readonly ok: true;
  readonly selectedBbCli: Pick<SelectedBbCli, "path" | "source" | "version">;
  readonly target: CompatibilityContract;
  readonly changes: readonly string[];
}

export interface CompatibilityUpgradeResult extends CompatibilityInspection {
  readonly updated: boolean;
}

export interface WorkspaceCheckOptions {
  readonly includeBuildMetadata?: boolean;
}

interface PlannedWrite {
  readonly path: string;
  readonly relativePath: string;
  readonly before: string | null;
  readonly after: string;
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

function jsonObject(path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ProcessError(
      "compatibility_workspace_invalid",
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProcessError(
      "compatibility_workspace_invalid",
      `${path} must contain a JSON object`,
    );
  }
  return value as Record<string, unknown>;
}

function readPluginManifest(path: string): PluginManifest {
  const value = jsonObject(path);
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw new ProcessError(
      "compatibility_workspace_invalid",
      `${path} is missing a non-empty package name`,
    );
  }
  return value as PluginManifest;
}

function isPluginName(name: string): boolean {
  return (name.split("/").at(-1) ?? name).startsWith("bb-plugin-");
}

function workspacePlugins(root: string): WorkspacePlugin[] {
  const pluginsRoot = join(root, "plugins");
  if (!existsSync(pluginsRoot) || !statSync(pluginsRoot).isDirectory()) {
    throw new ProcessError(
      "compatibility_workspace_invalid",
      `${root} has no plugins directory`,
    );
  }
  const plugins: WorkspacePlugin[] = [];
  for (const directory of readdirSync(pluginsRoot).sort()) {
    const pluginRoot = join(pluginsRoot, directory);
    const manifestPath = join(pluginRoot, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readPluginManifest(manifestPath);
    if (!isPluginName(manifest.name)) continue;
    plugins.push({ directory, root: pluginRoot, manifest });
  }
  return plugins;
}

export function findWorkspaceRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    const manifestPath = join(current, "package.json");
    if (
      existsSync(manifestPath)
      && existsSync(join(current, "plugins"))
      && existsSync(join(current, "packages", "bb-kit-cli"))
    ) {
      const manifest = jsonObject(manifestPath);
      if (
        typeof manifest.config === "object"
        && manifest.config !== null
        && "bbVersion" in manifest.config
      ) return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new ProcessError(
        "compatibility_workspace_not_found",
        `no bb-kit workspace found from ${start}`,
      );
    }
    current = parent;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactEngineRange(version: string): string {
  const [majorText, minorText] = version.split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new ProcessError(
      "compatibility_probe_invalid",
      `cannot derive an engine range from bb ${version}`,
    );
  }
  return `>=${version} <${major}.${minor + 1}.0`;
}

function stableVersionParts(version: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parts.every((part) => Number.isSafeInteger(part)) ? parts : null;
}

function compareStableVersions(left: string, right: string): number | null {
  const leftParts = stableVersionParts(left);
  const rightParts = stableVersionParts(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = (leftParts[index] as number) - (rightParts[index] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}

function stringPropertyName(property: Node): string | null {
  if (!Node.isPropertyAssignment(property)) return null;
  const name = property.getNameNode();
  if (Node.isStringLiteral(name) || Node.isNoSubstitutionTemplateLiteral(name)) {
    return name.getLiteralValue();
  }
  if (Node.isIdentifier(name)) return name.getText();
  return null;
}

function frontendHostShims(bbPath: string): string[] {
  let source: ReturnType<Project["createSourceFile"]>;
  try {
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    source = project.createSourceFile("selected-bb.js", readFileSync(bbPath, "utf8"));
  } catch (error) {
    throw new ProcessError(
      "compatibility_probe_invalid",
      `could not inspect bb's frontend host shims: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const candidates: string[][] = [];
  for (const declaration of source.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isObjectLiteralExpression(initializer)) continue;
    const entries: Array<[string, string]> = [];
    let valid = true;
    for (const property of initializer.getProperties()) {
      if (!Node.isPropertyAssignment(property)) {
        valid = false;
        break;
      }
      const name = stringPropertyName(property);
      const value = property.getInitializer();
      if (!name || !value || !Node.isStringLiteral(value)) {
        valid = false;
        break;
      }
      entries.push([name, value.getLiteralValue()]);
    }
    if (
      valid
      && entries.some(([name, value]) =>
        name === "@bb/plugin-sdk/app" && value === "pluginSdkApp",
      )
    ) candidates.push(entries.map(([name]) => name));
  }
  if (candidates.length !== 1) {
    throw new ProcessError(
      "compatibility_probe_invalid",
      `bb ${bbPath} exposed ${candidates.length} recognizable frontend shim maps; expected exactly one`,
    );
  }
  const shims = candidates[0] as string[];
  return [
    "@bb/plugin-sdk/app",
    ...shims.filter((specifier) => specifier !== "@bb/plugin-sdk/app"),
  ];
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  source: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field === "") {
    throw new ProcessError(
      "compatibility_probe_invalid",
      `${source} is missing string field ${key}`,
    );
  }
  return field;
}

function requiredNumber(
  value: Record<string, unknown>,
  key: string,
  source: string,
): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new ProcessError(
      "compatibility_probe_invalid",
      `${source} is missing non-negative integer field ${key}`,
    );
  }
  return field;
}

function defaultCompatibilityProbe(
  selected: SelectedBbCli,
  run: CommandRunner,
): ProbedCompatibility {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "bb-kit-compatibility-"));
  try {
    const scaffoldResult = run({
      file: selected.path,
      args: ["plugin", "new", "probe", "--app"],
      cwd: temporaryRoot,
      env: selected.env,
    });
    if (scaffoldResult.error || scaffoldResult.status !== 0) {
      throw new ProcessError(
        "compatibility_probe_failed",
        `bb ${selected.version} could not scaffold the compatibility probe: ${processFailure(scaffoldResult)}`,
      );
    }
    const probeRoot = join(temporaryRoot, "bb-plugin-probe");
    const buildResult = run({
      file: selected.path,
      args: ["plugin", "build", "."],
      cwd: probeRoot,
      env: selected.env,
    });
    if (buildResult.error || buildResult.status !== 0) {
      throw new ProcessError(
        "compatibility_probe_failed",
        `bb ${selected.version} could not build the compatibility probe: ${processFailure(buildResult)}`,
      );
    }

    const manifest = jsonObject(join(probeRoot, "package.json"));
    const engines = manifest.engines;
    if (typeof engines !== "object" || engines === null || Array.isArray(engines)) {
      throw new ProcessError(
        "compatibility_probe_invalid",
        "the bb scaffold has no engines object",
      );
    }
    const sdkRange = requiredString(
      engines as Record<string, unknown>,
      "bbPluginSdk",
      "the bb scaffold manifest",
    );
    const serverMetadata = jsonObject(join(probeRoot, "dist", "server.meta.json"));
    const appMetadata = jsonObject(join(probeRoot, "dist", "app.meta.json"));
    const sdkVersion = requiredString(serverMetadata, "sdkVersion", "server build metadata");
    const sdkMajor = requiredNumber(serverMetadata, "sdkMajor", "server build metadata");
    const artifactFormatVersion = requiredNumber(
      serverMetadata,
      "artifactFormatVersion",
      "server build metadata",
    );
    if (
      requiredString(appMetadata, "sdkVersion", "app build metadata") !== sdkVersion
      || requiredNumber(appMetadata, "sdkMajor", "app build metadata") !== sdkMajor
      || requiredNumber(appMetadata, "artifactFormatVersion", "app build metadata")
        !== artifactFormatVersion
    ) {
      throw new ProcessError(
        "compatibility_probe_invalid",
        "server and app build metadata disagree on the plugin SDK contract",
      );
    }
    if (sdkRange !== `^${sdkVersion}`) {
      throw new ProcessError(
        "compatibility_probe_invalid",
        `the scaffold declares plugin SDK ${sdkRange}, but build metadata reports ${sdkVersion}`,
      );
    }

    const server = readFileSync(join(probeRoot, "types", "bb-plugin-sdk.d.ts"), "utf8");
    const app = readFileSync(join(probeRoot, "types", "bb-plugin-sdk-app.d.ts"), "utf8");
    const components = jsonObject(join(probeRoot, "components.json"));
    const registries = components.registries;
    if (typeof registries !== "object" || registries === null || Array.isArray(registries)) {
      throw new ProcessError(
        "compatibility_probe_invalid",
        "the bb scaffold has no component registries object",
      );
    }
    const registryUrl = requiredString(
      registries as Record<string, unknown>,
      "@bb",
      "the bb scaffold component registry",
    );
    return {
      contract: {
        bbCliVersion: selected.version,
        engines: {
          bb: exactEngineRange(selected.version),
          bbPluginSdk: sdkRange,
        },
        pluginSdk: { version: sdkVersion, major: sdkMajor, artifactFormatVersion },
        declarations: {
          server: { path: "types/bb-plugin-sdk.d.ts", sha256: sha256(server) },
          app: { path: "types/bb-plugin-sdk-app.d.ts", sha256: sha256(app) },
        },
        hostShims: {
          server: ["@bb/plugin-sdk"],
          frontend: frontendHostShims(selected.path),
        },
        registryUrl,
      },
      declarations: { server, app },
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function compatibilityContractSource(contract: CompatibilityContract): string {
  return [
    "// Generated by `bb-kit compatibility upgrade`. Do not edit by hand.",
    `export const compatibility = ${JSON.stringify(contract, null, 2)} as const;`,
    "",
  ].join("\n");
}

function editJsonText(
  source: string,
  path: readonly (string | number)[],
  value: unknown,
): string {
  return applyEdits(source, modify(source, [...path], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  }));
}

function addPlannedWrite(
  writes: Map<string, PlannedWrite>,
  root: string,
  path: string,
  after: string,
): void {
  let before: string | null = null;
  if (existsSync(path)) {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new ProcessError(
        "compatibility_workspace_unsafe_target",
        `${relative(root, path)} must be one regular, non-linked file`,
      );
    }
    before = readFileSync(path, "utf8");
  }
  if (before === after) return;
  const relativePath = relative(root, path).replaceAll("\\", "/");
  writes.set(path, { path, relativePath, before, after });
}

function planCompatibilityUpgrade(
  root: string,
  probed: ProbedCompatibility,
): PlannedWrite[] {
  const writes = new Map<string, PlannedWrite>();
  const rootManifestPath = join(root, "package.json");
  const rootManifest = readFileSync(rootManifestPath, "utf8");
  addPlannedWrite(
    writes,
    root,
    rootManifestPath,
    editJsonText(rootManifest, ["config", "bbVersion"], probed.contract.bbCliVersion),
  );
  addPlannedWrite(
    writes,
    root,
    join(root, CONTRACT_PATH),
    compatibilityContractSource(probed.contract),
  );

  for (const plugin of workspacePlugins(root)) {
    const manifestPath = join(plugin.root, "package.json");
    let manifestSource = readFileSync(manifestPath, "utf8");
    manifestSource = editJsonText(
      manifestSource,
      ["engines", "bb"],
      probed.contract.engines.bb,
    );
    manifestSource = editJsonText(
      manifestSource,
      ["engines", "bbPluginSdk"],
      probed.contract.engines.bbPluginSdk,
    );
    addPlannedWrite(writes, root, manifestPath, manifestSource);
    addPlannedWrite(
      writes,
      root,
      join(plugin.root, probed.contract.declarations.server.path),
      probed.declarations.server,
    );
    if (plugin.manifest.bb?.app) {
      addPlannedWrite(
        writes,
        root,
        join(plugin.root, probed.contract.declarations.app.path),
        probed.declarations.app,
      );
    }
    const componentsPath = join(plugin.root, "components.json");
    if (existsSync(componentsPath)) {
      const source = readFileSync(componentsPath, "utf8");
      addPlannedWrite(
        writes,
        root,
        componentsPath,
        editJsonText(source, ["registries", "@bb"], probed.contract.registryUrl),
      );
    }
  }
  return [...writes.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

function applyTransaction(
  writes: readonly PlannedWrite[],
  validate: () => void,
): void {
  const createdDirectories: string[] = [];
  const createdDirectorySet = new Set<string>();
  for (const write of writes) {
    const current = existsSync(write.path) ? readFileSync(write.path, "utf8") : null;
    if (current !== write.before) {
      throw new ProcessError(
        "compatibility_workspace_changed",
        `${write.relativePath} changed after the upgrade was planned; no compatibility changes were written`,
      );
    }
  }
  try {
    for (const write of writes) {
      const current = existsSync(write.path) ? readFileSync(write.path, "utf8") : null;
      if (current !== write.before) {
        throw new ProcessError(
          "compatibility_workspace_changed",
          `${write.relativePath} changed while the upgrade was being applied; earlier compatibility writes were restored`,
        );
      }
      const missingDirectories: string[] = [];
      let directory = dirname(write.path);
      while (!existsSync(directory)) {
        missingDirectories.push(directory);
        directory = dirname(directory);
      }
      mkdirSync(dirname(write.path), { recursive: true });
      for (const created of missingDirectories) {
        if (createdDirectorySet.has(created)) continue;
        createdDirectorySet.add(created);
        createdDirectories.push(created);
      }
      writeFileSync(write.path, write.after);
    }
    validate();
  } catch (error) {
    for (const write of [...writes].reverse()) {
      if (write.before === null) rmSync(write.path, { force: true });
      else writeFileSync(write.path, write.before);
    }
    for (const directory of createdDirectories) {
      try {
        rmdirSync(directory);
      } catch {
        // Preserve a directory if another process placed content in it.
      }
    }
    throw error;
  }
}

function prefixDiagnostics(
  plugin: WorkspacePlugin,
  diagnostics: readonly Diagnostic[],
): Diagnostic[] {
  return diagnostics.map((value) => ({
    ...value,
    file: value.file
      ? `plugins/${plugin.directory}/${value.file}`
      : `plugins/${plugin.directory}`,
  }));
}

export function checkWorkspaceCompatibility(
  root: string,
  contract: CompatibilityContract = compatibility,
  options: WorkspaceCheckOptions = {},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  let rootManifest: Record<string, unknown>;
  try {
    rootManifest = jsonObject(join(root, "package.json"));
  } catch (error) {
    return [diagnostic(
      "BBKW000",
      error instanceof Error ? error.message : String(error),
      "Restore a valid workspace package.json before checking compatibility.",
      "package.json",
    )];
  }
  const config = typeof rootManifest.config === "object" && rootManifest.config !== null
    ? rootManifest.config as Record<string, unknown>
    : {};
  if (config.bbVersion !== contract.bbCliVersion) {
    diagnostics.push(diagnostic(
      "BBKW001",
      `root config.bbVersion is ${JSON.stringify(config.bbVersion)}, expected ${JSON.stringify(contract.bbCliVersion)}`,
      "Run bb-kit compatibility upgrade with the intended bb executable.",
      "package.json",
    ));
  }

  const contractPath = join(root, CONTRACT_PATH);
  const expectedContractSource = compatibilityContractSource(contract);
  if (!existsSync(contractPath) || readFileSync(contractPath, "utf8") !== expectedContractSource) {
    diagnostics.push(diagnostic(
      "BBKW002",
      "the generated compatibility contract is missing or was edited by hand",
      "Run bb-kit compatibility upgrade; do not edit the generated contract.",
      CONTRACT_PATH,
    ));
  }
  let plugins: WorkspacePlugin[];
  try {
    plugins = workspacePlugins(root);
  } catch (error) {
    diagnostics.push(diagnostic(
      "BBKW004",
      error instanceof Error ? error.message : String(error),
      "Restore valid plugin package manifests before checking compatibility.",
      "plugins",
    ));
    return diagnostics;
  }
  for (const plugin of plugins) {
    const manifestFile = `plugins/${plugin.directory}/package.json`;
    if (plugin.manifest.engines?.bb !== contract.engines.bb) {
      diagnostics.push(diagnostic(
        "BBKW005",
        `${plugin.manifest.name} engines.bb is ${JSON.stringify(plugin.manifest.engines?.bb)}, expected ${JSON.stringify(contract.engines.bb)}`,
        "Run bb-kit compatibility upgrade; future untested bb minors must remain excluded.",
        manifestFile,
      ));
    }
    if (plugin.manifest.engines?.bbPluginSdk !== contract.engines.bbPluginSdk) {
      diagnostics.push(diagnostic(
        "BBKW006",
        `${plugin.manifest.name} engines.bbPluginSdk is ${JSON.stringify(plugin.manifest.engines?.bbPluginSdk)}, expected ${JSON.stringify(contract.engines.bbPluginSdk)}`,
        "Run bb-kit compatibility upgrade with the intended bb executable.",
        manifestFile,
      ));
    }
    diagnostics.push(...prefixDiagnostics(
      plugin,
      checkSdkDeclarations(plugin.root, plugin.manifest, contract),
    ));

    const componentsPath = join(plugin.root, "components.json");
    if (existsSync(componentsPath)) {
      try {
        const components = jsonObject(componentsPath);
        const registries = typeof components.registries === "object"
          && components.registries !== null
          ? components.registries as Record<string, unknown>
          : {};
        if (registries["@bb"] !== contract.registryUrl) {
          diagnostics.push(diagnostic(
            "BBKW007",
            `${plugin.manifest.name} @bb component registry is ${JSON.stringify(registries["@bb"])}, expected ${JSON.stringify(contract.registryUrl)}`,
            "Run bb-kit compatibility upgrade; vendored component updates must come from the tested bb release.",
            `plugins/${plugin.directory}/components.json`,
          ));
        }
      } catch (error) {
        diagnostics.push(diagnostic(
          "BBKW007",
          error instanceof Error ? error.message : String(error),
          "Restore a valid components.json and run bb-kit compatibility upgrade.",
          `plugins/${plugin.directory}/components.json`,
        ));
      }
    }

    if (options.includeBuildMetadata !== false) {
      const serverMetadata = join(plugin.root, "dist", "server.meta.json");
      const appMetadata = join(plugin.root, "dist", "app.meta.json");
      if (existsSync(serverMetadata) || existsSync(appMetadata)) {
        diagnostics.push(...prefixDiagnostics(
          plugin,
          checkBuildMetadata(plugin.root, plugin.manifest, contract),
        ));
      }
    }
  }
  return diagnostics.sort((left, right) =>
    `${left.file ?? ""}:${left.code}`.localeCompare(`${right.file ?? ""}:${right.code}`),
  );
}

function selectedSummary(
  selected: SelectedBbCli,
): Pick<SelectedBbCli, "path" | "source" | "version"> {
  return { path: selected.path, source: selected.source, version: selected.version };
}

function inspectTarget(
  start: string,
  options: CompatibilityCommandOptions,
): {
  readonly root: string;
  readonly selected: SelectedBbCli;
  readonly probed: ProbedCompatibility;
  readonly writes: readonly PlannedWrite[];
} {
  const root = findWorkspaceRoot(start);
  const env = options.env ?? process.env;
  const run = options.run ?? defaultCommandRunner;
  const selected = inspectBbCli(root, env, run);
  const probed = defaultCompatibilityProbe(selected, run);
  if (probed.contract.bbCliVersion !== selected.version) {
    throw new ProcessError(
      "compatibility_probe_invalid",
      `the compatibility probe returned bb ${probed.contract.bbCliVersion} for selected bb ${selected.version}`,
    );
  }
  return { root, selected, probed, writes: planCompatibilityUpgrade(root, probed) };
}

export function inspectCompatibility(
  start: string,
  options: CompatibilityCommandOptions = {},
): CompatibilityInspection {
  const { selected, probed, writes } = inspectTarget(start, options);
  return {
    ok: true,
    selectedBbCli: selectedSummary(selected),
    target: probed.contract,
    changes: writes.map((write) => write.relativePath),
  };
}

export function upgradeCompatibility(
  start: string,
  options: CompatibilityCommandOptions = {},
): CompatibilityUpgradeResult {
  const { root, selected, probed, writes } = inspectTarget(start, options);
  const rootManifest = jsonObject(join(root, "package.json"));
  const config = typeof rootManifest.config === "object" && rootManifest.config !== null
    ? rootManifest.config as Record<string, unknown>
    : {};
  const currentVersion = config.bbVersion;
  const versionComparison = typeof currentVersion === "string"
    ? compareStableVersions(probed.contract.bbCliVersion, currentVersion)
    : null;
  if (
    typeof currentVersion === "string"
    && versionComparison !== null
    && versionComparison < 0
  ) {
    throw new ProcessError(
      "compatibility_downgrade_refused",
      `bb-kit will not downgrade the workspace from bb ${currentVersion} to ${probed.contract.bbCliVersion}`,
    );
  }
  if (writes.length > 0) {
    applyTransaction(writes, () => {
      const diagnostics = checkWorkspaceCompatibility(root, probed.contract, {
        includeBuildMetadata: false,
      });
      if (diagnostics.some((value) => value.severity === "error")) {
        throw new ProcessError(
          "compatibility_upgrade_invalid",
          `the planned upgrade failed its post-check at ${diagnostics[0]?.file ?? "the workspace"}: ${diagnostics[0]?.message ?? "unknown compatibility error"}`,
        );
      }
    });
  }
  return {
    ok: true,
    selectedBbCli: selectedSummary(selected),
    target: probed.contract,
    changes: writes.map((write) => write.relativePath),
    updated: writes.length > 0,
  };
}

export function formatCompatibilityInspection(
  result: CompatibilityInspection | CompatibilityUpgradeResult,
): string {
  const updated = "updated" in result ? result.updated : null;
  const heading = updated === null
    ? `bb ${result.target.bbCliVersion} compatibility plan`
    : updated ? `✓ upgraded to bb ${result.target.bbCliVersion}` : `✓ already on bb ${result.target.bbCliVersion}`;
  return [
    heading,
    `  CLI: ${result.selectedBbCli.path} (${result.selectedBbCli.source})`,
    `  Engine: ${result.target.engines.bb}`,
    `  Plugin SDK: ${result.target.pluginSdk.version}`,
    ...(result.changes.length === 0
      ? ["  No files would change."]
      : [
          `  ${result.changes.length} file(s) ${updated === null ? "would change" : "changed"}:`,
          ...result.changes.map((path) => `    ${path}`),
        ]),
  ].join("\n");
}
