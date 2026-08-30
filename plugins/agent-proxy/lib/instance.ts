import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PRODUCTION_PORT = 8317;
const PRODUCTION_CORE_LABEL = "com.bb.plugin.agent-proxy";
const PRODUCTION_TUNNEL_LABEL = "com.bb.plugin.agent-proxy.cloudflare-tunnel";
const DEVELOPMENT_PORT_BASE = 51_000;
const DEVELOPMENT_PORT_RANGE = 8_000;

const productionInstance = {
  kind: "production" as const,
  defaultPort: PRODUCTION_PORT,
  coreLabel: PRODUCTION_CORE_LABEL,
  tunnelLabel: PRODUCTION_TUNNEL_LABEL,
};

export function resolveAgentProxyInstance(dataDir: string, options: { homeDir?: string } = {}) {
  const homeDir = resolve(options.homeDir ?? homedir());
  const resolvedDataDir = resolve(dataDir);
  const developmentRoot = join(homeDir, ".bb-dev");
  const fromDevelopmentRoot = relative(developmentRoot, resolvedDataDir);
  const isInsideDevelopmentRoot =
    fromDevelopmentRoot === "" ||
    (!isAbsolute(fromDevelopmentRoot) &&
      fromDevelopmentRoot !== ".." &&
      !fromDevelopmentRoot.startsWith(`..${sep}`));

  if (!isInsideDevelopmentRoot) return productionInstance;

  const directoryName = basename(resolvedDataDir);
  const checkoutHash = directoryName.match(/([0-9a-f]{12})$/i)?.[1]?.toLowerCase();
  if (dirname(resolvedDataDir) !== developmentRoot || checkoutHash === undefined) {
    throw new Error(
      `Agent Proxy data directory ${dataDir} is not a valid direct BB development instance under ${developmentRoot}`,
    );
  }

  return {
    kind: "development" as const,
    defaultPort:
      DEVELOPMENT_PORT_BASE +
      (Number.parseInt(checkoutHash.slice(0, 8), 16) % DEVELOPMENT_PORT_RANGE),
    coreLabel: `${PRODUCTION_CORE_LABEL}.dev.${checkoutHash}`,
    tunnelLabel: `${PRODUCTION_CORE_LABEL}.dev.${checkoutHash}.cloudflare-tunnel`,
  };
}
