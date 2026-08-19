import { discoverProject } from "./project.js";
import { checkProject, type Diagnostic } from "./check.js";

export interface InspectResult {
  plugin: {
    name: string;
    id: string;
    server: string;
    app: string | null;
    compatibility: {
      bb: string | null;
      pluginSdk: string | null;
    };
  };
  modules: Array<{
    name: string;
    operations: Array<{
      identity: string;
      kind: string;
      risk: string | null;
      rpcMethod: string | null;
      input: import("./project.js").DiscoveredOperationInput | null;
      metadataError: string | null;
    }>;
    migrations: string[];
    surfaces: string[];
    storage: string | null;
  }>;
  diagnostics: Diagnostic[];
}

export function inspectProject(root: string): InspectResult {
  const info = discoverProject(root);
  return {
    plugin: {
      name: info.manifest.name,
      id: info.pluginId,
      server: info.serverEntry,
      app: info.appEntry,
      compatibility: {
        bb: info.manifest.engines?.bb ?? null,
        pluginSdk: info.manifest.engines?.bbPluginSdk ?? null,
      },
    },
    modules: info.modules.map((module) => ({
      name: module.name,
      operations: module.operations.map((operation) => ({
        identity: operation.identity,
        kind: operation.kind,
        risk: operation.risk,
        rpcMethod: operation.rpcMethod,
        input: operation.input,
        metadataError: operation.metadataError,
      })),
      migrations: module.migrations,
      surfaces: module.surfaces,
      storage: module.storage,
    })),
    diagnostics: checkProject(root),
  };
}

export function formatInfo(result: InspectResult): string {
  const lines = [
    `Plugin: ${result.plugin.name}`,
    `ID: ${result.plugin.id}`,
    `bb: ${result.plugin.compatibility.bb ?? "unspecified"}`,
    `Plugin SDK: ${result.plugin.compatibility.pluginSdk ?? "unspecified"}`,
    "",
    "Entrypoints",
    `  server  ${result.plugin.server}`,
    ...(result.plugin.app ? [`  app     ${result.plugin.app}`] : []),
    "",
    "Modules",
  ];
  if (result.modules.length === 0) lines.push("  (none)");
  for (const module of result.modules) {
    lines.push(`  ${module.name}`);
    for (const operation of module.operations) {
      lines.push(
        `    ${operation.kind.padEnd(7)} ${operation.identity}` +
          `${operation.risk ? ` [${operation.risk}]` : ""}` +
          ` → ${operation.rpcMethod ?? "unlocked"}` +
          ` (${operation.input?.mode ?? "invalid input"})`,
      );
    }
    if (module.migrations.length > 0) {
      lines.push(`    migrations ${module.migrations.join(", ")}`);
    }
    if (module.surfaces.length > 0) {
      lines.push(`    surfaces   ${module.surfaces.join(", ")}`);
    }
    if (module.storage) lines.push(`    storage    ${module.storage}`);
  }
  lines.push("", "Diagnostics");
  if (result.diagnostics.length === 0) lines.push("  ✓ No structural errors");
  else {
    for (const value of result.diagnostics) {
      lines.push(`  ✗ ${value.code} ${value.file ? `${value.file}: ` : ""}${value.message}`);
    }
  }
  return lines.join("\n");
}
