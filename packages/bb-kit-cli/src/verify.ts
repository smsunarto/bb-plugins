import { buildWithSelectedCli } from "./build.js";
import { checkProject, type Diagnostic } from "./check.js";
import {
  checkBuildMetadata,
  checkSdkDeclarations,
  compatibility,
} from "./compatibility.js";
import { checkPackedPackage, packedPaths } from "./package.js";
import {
  defaultCommandRunner,
  processFailure,
  ProcessError,
  resolvePathExecutable,
  resolveProjectExecutable,
  selectBbCli,
  type CommandRunner,
  type SelectedBbCli,
} from "./process.js";
import { readManifest } from "./project.js";

export interface VerificationStep {
  readonly name: "lint" | "typecheck" | "test" | "build" | "pack";
  readonly command: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly detail?: string;
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly steps: readonly VerificationStep[];
  readonly selectedBbCli?: Omit<SelectedBbCli, "env">;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface VerifyOptions {
  readonly run?: CommandRunner;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}

interface FixedStep {
  readonly name: "lint" | "typecheck" | "test";
  readonly file: string;
  readonly args: readonly string[];
  readonly command: string;
}

function protectedDiagnostics(root: string, includeMetadata: boolean): Diagnostic[] {
  const manifest = readManifest(root);
  return [
    ...checkSdkDeclarations(root, manifest),
    ...(includeMetadata ? checkBuildMetadata(root, manifest) : []),
  ];
}

function selectedSummary(selected: SelectedBbCli): Omit<SelectedBbCli, "env"> {
  return {
    path: selected.path,
    source: selected.source,
    version: selected.version,
  };
}

/** Run the complete non-live handoff gate through one bb-kit-owned toolchain. */
export function verifyProject(
  root: string,
  options: VerifyOptions = {},
): VerificationResult {
  const diagnostics = checkProject(root);
  if (diagnostics.some((value) => value.severity === "error")) {
    const declaration = diagnostics.find((value) => value.code === "BBK011");
    return {
      ok: false,
      diagnostics,
      steps: [],
      ...(declaration
        ? {
            error: {
              code: "sdk_declaration_drift",
              message: `${declaration.file ?? "SDK declaration"}: ${declaration.message}`,
            },
          }
        : {}),
    };
  }

  const run = options.run ?? defaultCommandRunner;
  const env = options.env ?? process.env;
  let selected: SelectedBbCli;
  let fixedSteps: readonly FixedStep[];
  let bun: string;
  try {
    selected = selectBbCli(root, env, compatibility.bbCliVersion, run);
    bun = resolvePathExecutable("bun", env) ?? (() => {
      throw new ProcessError("project_tool_not_found", "bun was not found on PATH");
    })();
    const oxlint = resolveProjectExecutable(root, "oxlint");
    const tsc = resolveProjectExecutable(root, "tsc");
    fixedSteps = [
      { name: "lint", file: oxlint, args: [], command: oxlint },
      { name: "typecheck", file: tsc, args: ["--noEmit"], command: `${tsc} --noEmit` },
      { name: "test", file: bun, args: ["test"], command: `${bun} test` },
    ];
  } catch (error) {
    const failure = error instanceof ProcessError
      ? error
      : new ProcessError("verification_preflight_failed", error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      diagnostics,
      steps: [],
      error: { code: failure.code, message: failure.message },
    };
  }

  const steps: VerificationStep[] = [];
  let failed = false;
  let verificationError: VerificationResult["error"];
  for (const step of fixedSteps) {
    if (failed) {
      steps.push({
        name: step.name,
        command: step.command,
        status: "skipped",
        detail: "an earlier step failed",
      });
      continue;
    }
    const result = run({
      file: step.file,
      args: step.args,
      cwd: root,
      env: selected.env,
    });
    const protectedOutput = protectedDiagnostics(root, false);
    diagnostics.push(...protectedOutput);
    if (result.status !== 0 || result.error || protectedOutput.length > 0) {
      failed = true;
      if (protectedOutput.length > 0) {
        const declaration = protectedOutput[0] as Diagnostic;
        verificationError = {
          code: "sdk_declaration_drift",
          message: `${declaration.file ?? "SDK declaration"} changed during ${step.name}: ${declaration.message}`,
        };
      }
      steps.push({
        name: step.name,
        command: step.command,
        status: "failed",
        detail: result.status !== 0 || result.error
          ? processFailure(result)
          : "protected SDK declarations changed during this step",
      });
    } else {
      steps.push({ name: step.name, command: step.command, status: "passed" });
    }
  }

  if (failed) {
    steps.push({
      name: "build",
      command: `${selected.path} plugin build .`,
      status: "skipped",
      detail: "an earlier step failed",
    });
  } else {
    const build = buildWithSelectedCli(root, selected, run);
    diagnostics.push(...build.diagnostics);
    steps.push({
      name: "build",
      command: build.command,
      status: build.status,
      ...(build.detail ? { detail: build.detail } : {}),
    });
    failed = !build.ok;
    if (build.error) verificationError = build.error;
  }

  const packCommand = `${bun} pm pack --dry-run`;
  if (failed) {
    steps.push({
      name: "pack",
      command: packCommand,
      status: "skipped",
      detail: "an earlier step failed",
    });
  } else {
    const result = run({
      file: bun,
      args: ["pm", "pack", "--dry-run"],
      cwd: root,
      env: selected.env,
    });
    if (result.status !== 0 || result.error) {
      failed = true;
      steps.push({
        name: "pack",
        command: packCommand,
        status: "failed",
        detail: processFailure(result),
      });
    } else {
      try {
        const manifest = readManifest(root);
        const paths = packedPaths(`${result.stdout}\n${result.stderr}`);
        const packageDiagnostics = [
          ...checkPackedPackage(root, manifest, paths),
          ...protectedDiagnostics(root, true),
        ];
        diagnostics.push(...packageDiagnostics);
        if (packageDiagnostics.length > 0) {
          failed = true;
          const declaration = packageDiagnostics.find((value) => value.code === "BBK011");
          const metadata = packageDiagnostics.find((value) => value.code === "BBK013");
          if (declaration) {
            verificationError = {
              code: "sdk_declaration_drift",
              message: `${declaration.file ?? "SDK declaration"} changed during pack: ${declaration.message}`,
            };
          } else if (metadata) {
            verificationError = {
              code: "build_metadata_mismatch",
              message: `${metadata.file ?? "build metadata"} changed during pack: ${metadata.message}`,
            };
          }
          steps.push({
            name: "pack",
            command: packCommand,
            status: "failed",
            detail: "package contents or protected build outputs failed bb-kit validation",
          });
        } else {
          steps.push({ name: "pack", command: packCommand, status: "passed" });
        }
      } catch (error) {
        failed = true;
        steps.push({
          name: "pack",
          command: packCommand,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    ok: !failed && !diagnostics.some((value) => value.severity === "error"),
    diagnostics,
    steps,
    selectedBbCli: selectedSummary(selected),
    ...(verificationError ? { error: verificationError } : {}),
  };
}

export function formatVerification(result: VerificationResult): string {
  const icon = { passed: "✓", failed: "✗", skipped: "–" } as const;
  const lines = result.selectedBbCli
    ? [`bb ${result.selectedBbCli.version}: ${result.selectedBbCli.path} (${result.selectedBbCli.source})`]
    : [];
  if (result.error) lines.push(`${result.error.code}: ${result.error.message}`);
  lines.push(...result.steps.map((step) =>
    `${icon[step.status]} ${step.name}: ${step.status}`
    + (step.detail ? `\n  ${step.detail.replaceAll("\n", "\n  ")}` : ""),
  ));
  if (result.diagnostics.length > 0) {
    lines.push("Diagnostics");
    for (const value of result.diagnostics) {
      lines.push(`  ${value.code} ${value.file ? `${value.file}: ` : ""}${value.message}`);
    }
  }
  lines.push(result.ok ? "✓ bb-kit verify passed" : "✗ bb-kit verify failed");
  return lines.join("\n");
}

export type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "./process.js";
