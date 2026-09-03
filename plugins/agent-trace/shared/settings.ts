export const DEFAULT_LAMINAR_ENDPOINT = "https://api.lmnr.ai/v1/traces";
export const DEFAULT_LANGFUSE_BASE_URL = "https://cloud.langfuse.com";
export const DEFAULT_DASHBOARD_URL = "";

export const AGENT_TRACE_SETTINGS = {
  laminarApiKey: {
    type: "string" as const,
    label: "Laminar project API key",
    secret: true as const,
  },
  laminarEndpoint: {
    type: "string" as const,
    label: "Laminar OTLP traces endpoint",
    default: DEFAULT_LAMINAR_ENDPOINT,
  },
  langfusePublicKey: {
    type: "string" as const,
    label: "Langfuse public key (pk-lf-...)",
  },
  langfuseSecretKey: {
    type: "string" as const,
    label: "Langfuse secret key (sk-lf-...)",
    secret: true as const,
  },
  langfuseBaseUrl: {
    type: "string" as const,
    label: "Langfuse base URL (cloud region or self-hosted origin)",
    default: DEFAULT_LANGFUSE_BASE_URL,
  },
  dashboardUrl: {
    type: "string" as const,
    label:
      "Embedded dashboard URL (optional; the Langfuse project URL or a self-hosted Laminar embed)",
    default: DEFAULT_DASHBOARD_URL,
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
}

export interface LangfuseConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

export interface AgentTraceConfig {
  contentMode: "metadata" | "full";
  deploymentEnvironment: string;
  laminar: LaminarConfig | null;
  langfuse: LangfuseConfig | null;
}

export interface AgentTraceSettingsValues {
  contentMode: string;
  dashboardUrl?: string;
  deploymentEnvironment: string;
  laminarApiKey?: string;
  laminarEndpoint: string;
  langfuseBaseUrl: string;
  langfusePublicKey?: string;
  langfuseSecretKey?: string;
}

export type ParsedAgentTraceSettings =
  | { ok: true; value: AgentTraceConfig }
  | { ok: false; message: string };

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url;
  } catch {
    return null;
  }
}

type BackendResult<T> = { ok: true; value: T | null } | { ok: false; message: string };

function parseLaminar(values: AgentTraceSettingsValues): BackendResult<LaminarConfig> {
  const apiKey = values.laminarApiKey?.trim();
  if (!apiKey) return { ok: true, value: null };
  const endpoint = httpUrl(values.laminarEndpoint);
  if (
    endpoint === null ||
    !endpoint.pathname.endsWith("/v1/traces") ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    return {
      ok: false,
      message: "Set a valid HTTP or HTTPS Laminar endpoint ending in /v1/traces.",
    };
  }
  return { ok: true, value: { apiKey, endpoint: endpoint.toString() } };
}

function parseLangfuse(values: AgentTraceSettingsValues): BackendResult<LangfuseConfig> {
  const publicKey = values.langfusePublicKey?.trim();
  const secretKey = values.langfuseSecretKey?.trim();
  if (!publicKey && !secretKey) return { ok: true, value: null };
  if (!publicKey || !secretKey) {
    return { ok: false, message: "Set both the Langfuse public key and secret key." };
  }
  const baseUrl = httpUrl(values.langfuseBaseUrl);
  if (baseUrl === null || baseUrl.search !== "" || baseUrl.hash !== "") {
    return {
      ok: false,
      message: "Set a valid HTTP or HTTPS Langfuse base URL such as https://cloud.langfuse.com.",
    };
  }
  return {
    ok: true,
    value: { baseUrl: baseUrl.toString().replace(/\/+$/, ""), publicKey, secretKey },
  };
}

export function parseAgentTraceSettings(
  values: AgentTraceSettingsValues,
): ParsedAgentTraceSettings {
  const laminar = parseLaminar(values);
  if (!laminar.ok) return laminar;
  const langfuse = parseLangfuse(values);
  if (!langfuse.ok) return langfuse;
  if (laminar.value === null && langfuse.value === null) {
    return {
      ok: false,
      message:
        "Set a Laminar project API key or Langfuse public and secret keys in plugin settings.",
    };
  }

  const deploymentEnvironment = values.deploymentEnvironment.trim();
  if (!deploymentEnvironment) {
    return { ok: false, message: "Set the deployment environment." };
  }

  if (values.contentMode !== "metadata" && values.contentMode !== "full") {
    return { ok: false, message: "Choose metadata or full trace content." };
  }

  return {
    ok: true,
    value: {
      contentMode: values.contentMode,
      deploymentEnvironment,
      laminar: laminar.value,
      langfuse: langfuse.value,
    },
  };
}
