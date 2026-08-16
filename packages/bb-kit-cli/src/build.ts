import { checkProject, type Diagnostic } from "./check.js";
import {
  checkBuildMetadata,
  checkSdkDependency,
  compatibility,
} from "./compatibility.js";
import {
  defaultCommandRunner,
  processFailure,
  ProcessError,
  selectBbCli,
  type CommandRunner,
  type SelectedBbCli,
} from "./process.js";
import { readManifest } from "./project.js";

export interface BuildResult {
  readonly ok: boolean;
  readonly command: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly detail?: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly selectedBbCli?: Omit<SelectedBbCli, "env">;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface BuildOptions {
  readonly run?: CommandRunner;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}

function compatibilityFailure(
  diagnostics: readonly Diagnostic[],
): BuildResult["error"] {
  const declaration = diagnostics.find((value) => value.code === "BBK011");
  if (declaration) {
    return {
      code: "sdk_declaration_drift",
      message: `${declaration.file ?? "SDK declaration"}: ${declaration.message}`,
    };
  }
  const metadata = diagnostics.find((value) => value.code === "BBK013");
  if (metadata) {
    return {
      code: "build_metadata_mismatch",
      message: `${metadata.file ?? "build metadata"}: ${metadata.message}`,
    };
  }
  return undefined;
}

export function buildWithSelectedCli(
  root: string,
  selectedBbCli: SelectedBbCli,
  run: CommandRunner,
): BuildResult {
  const manifest = readManifest(root);
  const command = `${selectedBbCli.path} plugin build .`;
  const result = run({
    file: selectedBbCli.path,
    args: ["plugin", "build", "."],
    cwd: root,
    env: selectedBbCli.env,
  });
  const diagnostics = [
    ...checkSdkDependency(root, manifest),
    ...(result.status === 0 && !result.error
      ? checkBuildMetadata(root, manifest)
      : []),
  ];
  if (result.status !== 0 || result.error || diagnostics.length > 0) {
    const compatibilityError = compatibilityFailure(diagnostics);
    return {
      ok: false,
      command,
      status: "failed",
      detail: result.status !== 0 || result.error
        ? processFailure(result)
        : "build output failed bb-kit compatibility checks",
      diagnostics,
      selectedBbCli: {
        path: selectedBbCli.path,
        source: selectedBbCli.source,
        version: selectedBbCli.version,
      },
      error: compatibilityError ?? {
        code: "build_failed",
        message: processFailure(result),
      },
    };
  }
  return {
    ok: true,
    command,
    status: "passed",
    diagnostics,
    selectedBbCli: {
      path: selectedBbCli.path,
      source: selectedBbCli.source,
      version: selectedBbCli.version,
    },
  };
}

export function buildProject(root: string, options: BuildOptions = {}): BuildResult {
  const command = "bb plugin build .";
  const diagnostics = checkProject(root);
  if (diagnostics.some((value) => value.severity === "error")) {
    const compatibilityError = compatibilityFailure(diagnostics);
    return {
      ok: false,
      command,
      status: "skipped",
      diagnostics,
      ...(compatibilityError ? { error: compatibilityError } : {}),
    };
  }
  const run = options.run ?? defaultCommandRunner;
  try {
    const selected = selectBbCli(
      root,
      options.env ?? process.env,
      compatibility.bbCliVersion,
      run,
    );
    return buildWithSelectedCli(root, selected, run);
  } catch (error) {
    const failure = error instanceof ProcessError
      ? error
      : new ProcessError("build_preflight_failed", error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      command,
      status: "skipped",
      diagnostics,
      error: { code: failure.code, message: failure.message },
    };
  }
}

export function formatBuild(result: BuildResult): string {
  const lines = [
    `${result.ok ? "✓" : "✗"} build: ${result.status}`,
    ...(result.selectedBbCli
      ? [`  bb ${result.selectedBbCli.version}: ${result.selectedBbCli.path} (${result.selectedBbCli.source})`]
      : []),
    ...(result.detail ? [`  ${result.detail.replaceAll("\n", "\n  ")}`] : []),
    ...(result.error ? [`  ${result.error.code}: ${result.error.message}`] : []),
  ];
  for (const value of result.diagnostics) {
    lines.push(`  ${value.code} ${value.file ? `${value.file}: ` : ""}${value.message}`);
  }
  return lines.join("\n");
}
