import { spawnSync } from "node:child_process";
import { checkProject, type Diagnostic } from "./check.js";
import { checkPackedPackage, packedPaths } from "./package.js";
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
}

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => CommandResult;

export interface VerifyOptions {
  readonly run?: CommandRunner;
}

function defaultRunner(
  command: string,
  args: readonly string[],
  cwd: string,
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function failureDetail(result: CommandResult): string {
  const value = redact(result.stderr.trim() || result.stdout.trim() || "command failed")
    .split("\n")
    .slice(-20)
    .join("\n");
  return value.length > 4_000 ? value.slice(-4_000) : value;
}

function redact(value: string): string {
  return value
    .replace(/(\b(?:api[-_]?key|password|secret|token)\s*[=:]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]");
}

/** Run the complete non-live handoff gate in the only safe order. */
export function verifyProject(
  root: string,
  options: VerifyOptions = {},
): VerificationResult {
  const diagnostics = checkProject(root);
  if (diagnostics.some((value) => value.severity === "error")) {
    return { ok: false, diagnostics, steps: [] };
  }

  const manifest = readManifest(root);
  const scripts = typeof manifest.scripts === "object" && manifest.scripts !== null
    ? manifest.scripts as Record<string, unknown>
    : {};
  const run = options.run ?? defaultRunner;
  const steps: VerificationStep[] = [];
  let failed = false;

  for (const name of ["lint", "typecheck", "test", "build"] as const) {
    const script = scripts[name];
    const command = `bun run ${name}`;
    if (typeof script !== "string" || script.trim() === "") {
      if (name === "build") {
        failed = true;
        steps.push({ name, command, status: "failed", detail: "build script not declared" });
      } else {
        steps.push({ name, command, status: "skipped", detail: "script not declared" });
      }
      continue;
    }
    if (failed) {
      steps.push({ name, command, status: "skipped", detail: "an earlier step failed" });
      continue;
    }
    const result = run("bun", ["run", name], root);
    if (result.status === 0) steps.push({ name, command, status: "passed" });
    else {
      failed = true;
      steps.push({
        name,
        command,
        status: "failed",
        detail: failureDetail(result),
      });
    }
  }

  const packCommand = "bun pm pack --dry-run";
  if (failed) {
    steps.push({
      name: "pack",
      command: packCommand,
      status: "skipped",
      detail: "an earlier step failed",
    });
  } else {
    const result = run("bun", ["pm", "pack", "--dry-run"], root);
    if (result.status !== 0) {
      failed = true;
      steps.push({
        name: "pack",
        command: packCommand,
        status: "failed",
        detail: failureDetail(result),
      });
    } else {
      try {
        const paths = packedPaths(`${result.stdout}\n${result.stderr}`);
        const packageDiagnostics = checkPackedPackage(root, manifest, paths);
        diagnostics.push(...packageDiagnostics);
        if (packageDiagnostics.length > 0) {
          failed = true;
          steps.push({
            name: "pack",
            command: packCommand,
            status: "failed",
            detail: "package contents failed bb-kit validation",
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
  };
}

export function formatVerification(result: VerificationResult): string {
  const icon = { passed: "✓", failed: "✗", skipped: "–" } as const;
  const lines = result.steps.map((step) =>
    `${icon[step.status]} ${step.name}: ${step.status}`
    + (step.detail ? `\n  ${step.detail.replaceAll("\n", "\n  ")}` : ""),
  );
  if (result.diagnostics.length > 0) {
    lines.push("Diagnostics");
    for (const value of result.diagnostics) {
      lines.push(
        `  ${value.code} ${value.file ? `${value.file}: ` : ""}${value.message}`,
      );
    }
  }
  lines.push(result.ok ? "✓ bb-kit verify passed" : "✗ bb-kit verify failed");
  return lines.join("\n");
}
