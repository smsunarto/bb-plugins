import { isAbsolute, join } from "node:path";

/** On-disk layout under <bb dataDir>/plugins/agent-proxy. Coexists with bb's
    own data.db / secrets/ / logs for this plugin. */
export interface Paths {
  root: string;
  coreDir: string;
  binDir: string;
  versionsDir: string;
  currentLink: string;
  binPath: string;
  versionMarker: string;
  legacyBinPath: string;
  legacyVersionMarker: string;
  configPath: string;
  authDir: string;
  serviceDir: string;
  serviceLogPath: string;
  runtimeFingerprintPath: string;
  tunnelDir: string;
  tunnelConfigPath: string;
  tunnelObservationPath: string;
  tunnelLogPath: string;
  tunnelRuntimeDir: string;
  secretsDir: string;
  managementKeyPath: string;
  managementKeyOverridePath: string;
  localApiKeyPath: string;
  backupsDir: string;
  agentsDir: string;
  codexHomeDir: string;
  codexConfigPath: string;
  claudeStatePath: string;
  claudePendingStatePath: string;
}

export function buildPaths(dataDir: string): Paths {
  const root = join(dataDir, "plugins", "agent-proxy");
  const coreDir = join(root, "core");
  const binDir = join(coreDir, "bin");
  const currentLink = join(binDir, "current");
  const coreExecutable = "cli-proxy-api";
  const serviceDir = join(coreDir, "service");
  const tunnelDir = join(root, "cloudflare-tunnel");
  const secretsDir = join(coreDir, "secrets");
  const agentsDir = join(root, "agents");
  const codexHomeDir = join(agentsDir, "codex-home");
  return {
    root,
    coreDir,
    binDir,
    versionsDir: join(coreDir, "versions"),
    currentLink,
    binPath: join(currentLink, coreExecutable),
    versionMarker: join(currentLink, ".version"),
    legacyBinPath: join(binDir, coreExecutable),
    legacyVersionMarker: join(binDir, ".version"),
    configPath: join(coreDir, "config.yaml"),
    authDir: join(coreDir, "auth"),
    serviceDir,
    serviceLogPath: join(serviceDir, "core.log"),
    runtimeFingerprintPath: join(serviceDir, "runtime-fingerprint"),
    tunnelDir,
    tunnelConfigPath: join(tunnelDir, "desired.json"),
    tunnelObservationPath: join(tunnelDir, "observation.json"),
    tunnelLogPath: join(tunnelDir, "tunnel.log"),
    tunnelRuntimeDir: join(tunnelDir, "runtime"),
    secretsDir,
    managementKeyPath: join(secretsDir, "management-key"),
    managementKeyOverridePath: join(secretsDir, "management-key-override"),
    localApiKeyPath: join(secretsDir, "local-api-key"),
    backupsDir: join(root, "backups"),
    agentsDir,
    codexHomeDir,
    codexConfigPath: join(codexHomeDir, "config.toml"),
    claudeStatePath: join(agentsDir, "claude-env-state.json"),
    claudePendingStatePath: join(agentsDir, "claude-env-state.pending.json"),
  };
}

export function systemdUserUnitPath(
  homeDir: string,
  label: string,
  xdgConfigHome: string | undefined = process.env.XDG_CONFIG_HOME,
): string {
  const configHome = xdgConfigHome?.trim() || join(homeDir, ".config");
  if (!isAbsolute(configHome)) {
    throw new Error("XDG_CONFIG_HOME must be an absolute path");
  }
  return join(configHome, "systemd", "user", `${label}.service`);
}
