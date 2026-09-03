export const DEFAULT_LAMINAR_ENDPOINT = "https://api.lmnr.ai/v1/traces";
export const DEFAULT_LAMINAR_DASHBOARD_URL = "http://127.0.0.1:5668/";

export const LAMINAR_SETTINGS = {
  apiKey: {
    type: "string" as const,
    label: "Project API key",
    secret: true as const,
  },
  endpoint: {
    type: "string" as const,
    label: "OTLP traces endpoint",
    default: DEFAULT_LAMINAR_ENDPOINT,
  },
  dashboardUrl: {
    type: "string" as const,
    label: "Dashboard URL",
    default: DEFAULT_LAMINAR_DASHBOARD_URL,
  },
  deploymentEnvironment: {
    type: "string" as const,
    label: "Deployment environment",
    default: "development",
  },
  contentMode: {
    type: "select" as const,
    label: "Trace content (full includes input/output)",
    options: ["metadata", "full"],
    default: "metadata",
  },
};

export interface LaminarConfig {
  apiKey: string;
  endpoint: string;
  deploymentEnvironment: string;
  contentMode: "metadata" | "full";
}

export interface LaminarSettingsValues {
  apiKey?: string;
  endpoint: string;
  deploymentEnvironment: string;
  contentMode: string;
}

export type ParsedLaminarSettings =
  | { ok: true; value: LaminarConfig }
  | { ok: false; message: string };

export function parseLaminarSettings(values: LaminarSettingsValues): ParsedLaminarSettings {
  const apiKey = values.apiKey?.trim();
  if (!apiKey) {
    return { ok: false, message: "Set the Laminar project API key in plugin settings." };
  }

  let endpoint: URL;
  try {
    endpoint = new URL(values.endpoint.trim());
  } catch {
    return {
      ok: false,
      message: "Set a valid HTTP or HTTPS Laminar endpoint ending in /v1/traces.",
    };
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    !endpoint.pathname.endsWith("/v1/traces") ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.username !== "" ||
    endpoint.password !== ""
  ) {
    return {
      ok: false,
      message: "Set a valid HTTP or HTTPS Laminar endpoint ending in /v1/traces.",
    };
  }

  const deploymentEnvironment = values.deploymentEnvironment.trim();
  if (!deploymentEnvironment) {
    return { ok: false, message: "Set the Laminar deployment environment." };
  }

  if (values.contentMode !== "metadata" && values.contentMode !== "full") {
    return { ok: false, message: "Choose metadata or full trace content." };
  }

  return {
    ok: true,
    value: {
      apiKey,
      endpoint: endpoint.toString(),
      deploymentEnvironment,
      contentMode: values.contentMode,
    },
  };
}
