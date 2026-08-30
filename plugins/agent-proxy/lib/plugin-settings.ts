export const ROUTING_STRATEGIES = ["round-robin", "fill-first", "weighted-round-robin"] as const;

export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];

export interface AgentProxySettings {
  autostart: boolean;
  cloudflareQuickTunnelForCursor: boolean;
  port: number;
  sourceRepository: string;
  sourceBranch: string;
  routingStrategy: RoutingStrategy;
}

export const DEFAULT_AGENT_PROXY_SETTINGS: AgentProxySettings = {
  autostart: true,
  cloudflareQuickTunnelForCursor: false,
  port: 8317,
  sourceRepository: "router-for-me/CLIProxyAPI",
  sourceBranch: "latest",
  routingStrategy: "round-robin",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function portOr(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
}

function routingStrategyOr(value: unknown, fallback: RoutingStrategy): RoutingStrategy {
  return typeof value === "string" && ROUTING_STRATEGIES.includes(value as RoutingStrategy)
    ? (value as RoutingStrategy)
    : fallback;
}

export function normalizeAgentProxySettings(value: unknown): AgentProxySettings {
  const source = isRecord(value) ? value : {};
  return {
    autostart: booleanOr(source.autostart, DEFAULT_AGENT_PROXY_SETTINGS.autostart),
    cloudflareQuickTunnelForCursor: booleanOr(
      source.cloudflareQuickTunnelForCursor,
      DEFAULT_AGENT_PROXY_SETTINGS.cloudflareQuickTunnelForCursor,
    ),
    port: portOr(source.port, DEFAULT_AGENT_PROXY_SETTINGS.port),
    sourceRepository: stringOr(
      source.sourceRepository,
      DEFAULT_AGENT_PROXY_SETTINGS.sourceRepository,
    ),
    sourceBranch: stringOr(source.sourceBranch, DEFAULT_AGENT_PROXY_SETTINGS.sourceBranch),
    routingStrategy: routingStrategyOr(
      source.routingStrategy,
      DEFAULT_AGENT_PROXY_SETTINGS.routingStrategy,
    ),
  };
}
