import { dirname } from "node:path";
import {
  LaunchdPersistentService,
  SystemdPersistentService,
  parseLaunchctlPrint,
  parseSystemctlShow,
  renderLaunchAgentPlist as renderPersistentLaunchAgentPlist,
  renderSystemdUserUnit as renderPersistentSystemdUserUnit,
  type CommandResult,
  type CommandRunner,
  type PersistentService,
  type ServiceManager,
  type ServiceSnapshot,
  type ServiceState,
} from "./persistent-service.ts";

export type CoreState = ServiceState;
export type SupervisorSnapshot = ServiceSnapshot;
export type CoreSupervisor = PersistentService;
export type { CommandResult, CommandRunner, ServiceManager };
export { parseLaunchctlPrint, parseSystemctlShow };

export interface LaunchdSupervisorOptions {
  label: string;
  uid: number;
  plistPath: string;
  binPath: string;
  configPath: string;
  logPath: string;
  isInstalled: () => boolean;
  probeUrl: () => string;
  onChange?: (snapshot: SupervisorSnapshot) => void;
  onError?: (error: unknown) => void;
  runCommand?: CommandRunner;
  fetchImpl?: typeof fetch;
  monitorIntervalMs?: number;
  probeTimeoutMs?: number;
  logLimit?: number;
  platform?: NodeJS.Platform;
  now?: () => number;
}

export interface SystemdSupervisorOptions {
  label: string;
  unitPath: string;
  binPath: string;
  configPath: string;
  logPath: string;
  isInstalled: () => boolean;
  probeUrl: () => string;
  onChange?: (snapshot: SupervisorSnapshot) => void;
  onError?: (error: unknown) => void;
  runCommand?: CommandRunner;
  fetchImpl?: typeof fetch;
  monitorIntervalMs?: number;
  probeTimeoutMs?: number;
  logLimit?: number;
  platform?: NodeJS.Platform;
  now?: () => number;
  systemctlPath?: string;
}

function coreProgram(options: {
  binPath: string;
  configPath: string;
  logPath: string;
  probeUrl: () => string;
}) {
  return {
    command: [options.binPath, "--config", options.configPath] as const,
    workingDirectory: dirname(options.configPath),
    logPath: options.logPath,
    readinessUrl: options.probeUrl,
  };
}

export function renderLaunchAgentPlist(options: {
  label: string;
  binPath: string;
  configPath: string;
  logPath: string;
}): string {
  return renderPersistentLaunchAgentPlist({
    label: options.label,
    program: coreProgram({ ...options, probeUrl: () => "" }),
  });
}

export function renderSystemdUserUnit(options: {
  label: string;
  binPath: string;
  configPath: string;
  logPath: string;
}): string {
  return renderPersistentSystemdUserUnit({
    label: options.label,
    program: coreProgram({ ...options, probeUrl: () => "" }),
  });
}

export class LaunchdSupervisor extends LaunchdPersistentService {
  constructor(options: LaunchdSupervisorOptions) {
    const { binPath, configPath, logPath, probeUrl, ...serviceOptions } = options;
    super({
      ...serviceOptions,
      program: coreProgram({ binPath, configPath, logPath, probeUrl }),
    });
  }
}

export class SystemdSupervisor extends SystemdPersistentService {
  constructor(options: SystemdSupervisorOptions) {
    const { binPath, configPath, logPath, probeUrl, ...serviceOptions } = options;
    super({
      ...serviceOptions,
      program: coreProgram({ binPath, configPath, logPath, probeUrl }),
    });
  }
}
