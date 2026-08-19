export { checkProject, formatDiagnostic, type Diagnostic } from "./check.js";
export { buildProject, formatBuild, type BuildOptions, type BuildResult } from "./build.js";
export { runCli, type CliIo, type RunCliOptions } from "./command.js";
export {
  addFixture,
  addMigration,
  addModule,
  addOperation,
  addPanel,
  initializeProject,
  type InitOptions,
  type PanelLocation,
  type PluginKind,
} from "./generate.js";
export { formatInfo, inspectProject, type InspectResult } from "./info.js";
export { doctorProject, formatDoctor, type DoctorOptions, type DoctorReport } from "./doctor.js";
export {
  invokeOperation,
  InvocationError,
  type InvocationResult,
  type InvokeOptions,
} from "./invoke.js";
export {
  FixtureError,
  formatFixtureRun,
  runFixtures,
  type FixtureRunOptions,
  type FixtureRunResult,
  type FixtureScenarioResult,
} from "./fixtures.js";
export {
  defaultWireMethod,
  derivePluginId,
  discoverProject,
  findProjectRoot,
  readLock,
  writeLock,
  type BbKitLock,
  type ProjectInfo,
  type DiscoveredOperationInput,
} from "./project.js";
export {
  formatVerification,
  verifyProject,
  type CommandResult,
  type CommandRunner,
  type VerificationResult,
  type VerificationStep,
  type VerifyOptions,
} from "./verify.js";
