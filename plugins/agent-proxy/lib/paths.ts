import { join } from "node:path";

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
  secretsDir: string;
  managementKeyPath: string;
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
  const secretsDir = join(coreDir, "secrets");
  const agentsDir = join(root, "agents");
  const codexHomeDir = join(agentsDir, "codex-home");
  return {
    root,
    coreDir,
    binDir,
    versionsDir: join(coreDir, "versions"),
    currentLink,
    binPath: join(currentLink, "cli-proxy-api"),
    versionMarker: join(currentLink, ".version"),
    legacyBinPath: join(binDir, "cli-proxy-api"),
    legacyVersionMarker: join(binDir, ".version"),
    configPath: join(coreDir, "config.yaml"),
    authDir: join(coreDir, "auth"),
    secretsDir,
    managementKeyPath: join(secretsDir, "management-key"),
    localApiKeyPath: join(secretsDir, "local-api-key"),
    backupsDir: join(root, "backups"),
    agentsDir,
    codexHomeDir,
    codexConfigPath: join(codexHomeDir, "config.toml"),
    claudeStatePath: join(agentsDir, "claude-env-state.json"),
    claudePendingStatePath: join(agentsDir, "claude-env-state.pending.json"),
  };
}
