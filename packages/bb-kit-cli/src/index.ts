export { formatDiagnostic, type Diagnostic } from "./check.js";
export { runCli, type CliIo, type RunCliOptions } from "./command.js";
export { compatibility, type CompatibilityContract } from "./compatibility.js";
export {
  checkWorkspaceCompatibility,
  findWorkspaceRoot,
  formatCompatibilityInspection,
  inspectCompatibility,
  upgradeCompatibility,
  type CompatibilityCommandOptions,
  type CompatibilityInspection,
  type CompatibilityUpgradeResult,
} from "./compatibility-workspace.js";
export type { CommandRequest, CommandResult, CommandRunner } from "./process.js";
