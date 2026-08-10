// Thin typed client for the CLIProxyAPI management API
// (http://127.0.0.1:<port>/v0/management). Provider collections deliberately
// use GET + whole-array PUT only — the UI edits lists client-side and saves
// the full array, avoiding the API's PATCH index/match conventions.

export type OAuthProvider = "anthropic" | "codex";

export const RESOURCES = [
  "claude-api-key",
  "codex-api-key",
  "gemini-api-key",
  "openai-compatibility",
  "api-keys",
] as const;

export type Resource = (typeof RESOURCES)[number];

export class ManagementError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ManagementError";
    this.status = status;
  }
}

export interface OAuthStatus {
  status: "pending" | "ok" | "error";
  detail: string | null;
}

export interface ManagementClientOptions {
  port: number;
  key: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ManagementClient {
  private readonly options: ManagementClientOptions;

  constructor(options: ManagementClientOptions) {
    this.options = options;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = `http://127.0.0.1:${this.options.port}/v0/management${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.key}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch {
      throw new ManagementError(0, "proxy core is not reachable — is it running?");
    }
    if (response.status === 401 || response.status === 403) {
      throw new ManagementError(
        response.status,
        "management API rejected the key — the core's secret and the plugin's key are out of sync; rotate the key from the Home page",
      );
    }
    if (response.status === 404 && path !== "/latest-version") {
      throw new ManagementError(
        404,
        `management API returned 404 for ${path} — management may be disabled or another process owns the port`,
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ManagementError(
        response.status,
        `management API ${method} ${path} failed: HTTP ${response.status}${text ? ` — ${text.slice(0, 300)}` : ""}`,
      );
    }
    const text = await response.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async authUrl(provider: OAuthProvider): Promise<{ url: string; state: string }> {
    const path = provider === "anthropic" ? "/anthropic-auth-url" : "/codex-auth-url";
    const result = (await this.request("GET", `${path}?is_webui=true`)) as Record<string, unknown>;
    if (typeof result?.url !== "string" || typeof result?.state !== "string") {
      throw new ManagementError(0, `unexpected ${path} response from the core`);
    }
    return { url: result.url, state: result.state };
  }

  async authStatus(state: string): Promise<OAuthStatus> {
    const result = (await this.request(
      "GET",
      `/get-auth-status?state=${encodeURIComponent(state)}`,
    )) as Record<string, unknown>;
    const status = result?.status;
    if (status === "ok") return { status: "ok", detail: null };
    if (status === "error") {
      return { status: "error", detail: typeof result.error === "string" ? result.error : "unknown error" };
    }
    return { status: "pending", detail: null };
  }

  async authFiles(): Promise<Record<string, unknown>[]> {
    const result = await this.request("GET", "/auth-files");
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    // Some versions wrap the list in an object; find the first array value.
    if (typeof result === "object" && result !== null) {
      for (const value of Object.values(result)) {
        if (Array.isArray(value)) return value as Record<string, unknown>[];
      }
    }
    return [];
  }

  async setAuthFileStatus(name: string, disabled: boolean): Promise<void> {
    await this.request("PATCH", "/auth-files/status", { name, disabled });
  }

  async deleteAuthFile(name: string): Promise<void> {
    await this.request("DELETE", `/auth-files?name=${encodeURIComponent(name)}`);
  }

  async resetQuota(authIndex: string): Promise<void> {
    await this.request("POST", "/reset-quota", { auth_index: authIndex });
  }

  async getResource(resource: Resource): Promise<unknown[]> {
    const result = await this.request("GET", `/${resource}`);
    // Current cores wrap GET collections by resource name, while historical
    // versions returned the array directly. Both use a bare array for PUT.
    if (Array.isArray(result)) return result;
    if (typeof result === "object" && result !== null) {
      const value = (result as Record<string, unknown>)[resource];
      if (Array.isArray(value)) return value;
    }
    throw new ManagementError(0, `unexpected /${resource} response from the core`);
  }

  async putResource(resource: Resource, value: unknown[]): Promise<void> {
    await this.request("PUT", `/${resource}`, value);
  }

  async usage(): Promise<unknown> {
    return this.request("GET", "/api-key-usage");
  }

  async latestVersion(): Promise<unknown> {
    return this.request("GET", "/latest-version");
  }
}
