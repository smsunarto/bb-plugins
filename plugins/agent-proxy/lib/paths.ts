import { join } from "node:path";

/** On-disk layout under <bb dataDir>/plugins/agent-proxy. Coexists with bb's
    own data.db / secrets/ / logs for this plugin. */
export interface Paths {
  root: string;
  coreDir: string;
  binDir: string;
  binPath: string;
  versionMarker: string;
  configPath: string;
  authDir: string;
  secretsDir: string;
  managementKeyPath: string;
  localApiKeyPath: string;
  backupsDir: string;
  agentsDir: string;
  codexHomeDir: string;
  codexConfigPath: string;
}

export function buildPaths(dataDir: string): Paths {
  const root = join(dataDir, "plugins", "agent-proxy");
  const coreDir = join(root, "core");
  const binDir = join(coreDir, "bin");
  const secretsDir = join(coreDir, "secrets");
  const agentsDir = join(root, "agents");
  const codexHomeDir = join(agentsDir, "codex-home");
  return {
    root,
    coreDir,
    binDir,
    binPath: join(binDir, "cli-proxy-api"),
    versionMarker: join(binDir, ".version"),
    configPath: join(coreDir, "config.yaml"),
    authDir: join(coreDir, "auth"),
    secretsDir,
    managementKeyPath: join(secretsDir, "management-key"),
    localApiKeyPath: join(secretsDir, "local-api-key"),
    backupsDir: join(root, "backups"),
    agentsDir,
    codexHomeDir,
    codexConfigPath: join(codexHomeDir, "config.toml"),
  };
}
