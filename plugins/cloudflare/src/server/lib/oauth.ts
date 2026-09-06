import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { OAuthStatus } from "../../shared/schema.ts";
import { CloudflareError } from "./api.ts";

export const OAUTH_CALLBACK_PATH = "/api/v1/plugins/cloudflare/http/oauth/callback";
const AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";
const OFFLINE_SCOPE = "offline_access";
// RFC 6749 scope-token. Cloudflare owns the meaning of these opaque IDs.
const scopeSchema = z
  .string()
  .max(128)
  .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/);
const STATE_TTL = 10 * 60 * 1000;
const REFRESH_MARGIN = 60 * 1000;
const MAX_PENDING = 10;
const reconnect = "Connect Cloudflare again to renew authorization.";

export interface OAuthSettings {
  oauthClientId?: string;
  oauthRedirectUri?: string;
  accountId?: string;
  oauthCredentials?: string;
  oauthScopes?: string;
}
const bindingSchema = z.object({
  clientId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
  redirectUri: z.string().max(2048),
  accountId: z.string().regex(/^[a-f0-9]{32}$/i),
  scopes: z.array(scopeSchema).min(2).max(65),
});
type Binding = z.infer<typeof bindingSchema>;
const credentialsSchema = bindingSchema.extend({
  version: z.literal(1),
  accessToken: z.string().min(1).max(32768),
  refreshToken: z.string().min(1).max(32768),
  expiresAt: z.number().int().positive().max(8.64e15),
});
type Credentials = z.infer<typeof credentialsSchema>;
const tokenSchema = z.object({
  access_token: z.string().min(1).max(32768),
  refresh_token: z.string().min(1).max(32768).optional(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(365 * 24 * 60 * 60),
  scope: z.string().optional(),
});
export interface OAuthDependencies {
  settings: () => Promise<OAuthSettings>;
  save: (credentials: string | null) => Promise<void>;
  fetcher?: typeof fetch;
  now?: () => number;
}
function sameBinding(a: Binding, b: Binding): boolean {
  return (
    a.clientId === b.clientId &&
    a.redirectUri === b.redirectUri &&
    a.accountId === b.accountId &&
    a.scopes.join(" ") === b.scopes.join(" ")
  );
}
function parseScopes(raw: string | undefined): string[] {
  if (!raw || raw.length > 8192) return [];
  const permissions = [
    ...new Set(
      raw
        .trim()
        .split(/\s+/)
        .filter((scope) => scope !== OFFLINE_SCOPE),
    ),
  ];
  if (
    !permissions.length ||
    permissions.length > 64 ||
    permissions.some((scope) => !scopeSchema.safeParse(scope).success)
  )
    return [];
  return [...permissions, OFFLINE_SCOPE].sort();
}
function binding(settings: OAuthSettings): Binding | undefined {
  const result = bindingSchema.safeParse({
    clientId: settings.oauthClientId?.trim(),
    redirectUri: settings.oauthRedirectUri?.trim(),
    accountId: settings.accountId?.trim(),
    scopes: parseScopes(settings.oauthScopes),
  });
  if (!result.success) return;
  try {
    const url = new URL(result.data.redirectUri);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== OAUTH_CALLBACK_PATH ||
      url.href !== result.data.redirectUri
    )
      return;
  } catch {
    return;
  }
  return result.data;
}
function readCredentials(raw: string | undefined): Credentials | undefined {
  if (!raw) return;
  try {
    const result = credentialsSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return;
  }
}

export class CloudflareOAuth {
  private readonly deps: OAuthDependencies;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly pending = new Map<
    string,
    { binding: Binding; verifier: string; expiresAt: number; generation: number }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private closing = false;
  constructor(deps: OAuthDependencies) {
    this.deps = deps;
    this.fetcher = deps.fetcher ?? fetch;
    this.now = deps.now ?? Date.now;
  }
  async dispose() {
    this.closing = true;
    this.generation++;
    this.pending.clear();
    await this.queue;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new CloudflareError("Cloudflare plugin is reloading. Retry after it finishes."),
      );
    const next = this.queue.then(() => {
      if (this.closing)
        throw new CloudflareError("Cloudflare plugin is reloading. Retry after it finishes.");
      return operation();
    });
    this.queue = next.catch(() => {});
    return next;
  }
  private async settings() {
    try {
      return await this.deps.settings();
    } catch {
      throw new CloudflareError("Cloudflare OAuth settings could not be loaded.");
    }
  }
  private async save(value: Credentials | null) {
    try {
      await this.deps.save(value ? JSON.stringify(value) : null);
    } catch {
      throw new CloudflareError("Cloudflare authorization could not be saved. Retry connecting.");
    }
  }
  async status(): Promise<OAuthStatus> {
    const settings = await this.settings();
    const config = binding(settings);
    const credentials = readCredentials(settings.oauthCredentials);
    const missing = [
      ...(!settings.oauthClientId?.trim() ? ["OAuth client ID"] : []),
      ...(!settings.oauthRedirectUri?.trim() ? ["OAuth callback URL"] : []),
      ...(!settings.accountId?.trim() ? ["Account ID"] : []),
      ...(!settings.oauthScopes?.trim() || settings.oauthScopes.trim() === OFFLINE_SCOPE
        ? ["OAuth permissions"]
        : []),
    ];
    const connected = Boolean(config && credentials && sameBinding(config, credentials));
    return {
      configured: Boolean(config),
      connected,
      accountId: settings.accountId?.trim() ?? "",
      clientId: settings.oauthClientId?.trim() ?? "",
      redirectUri: settings.oauthRedirectUri?.trim() ?? "",
      missing,
      ...(connected && credentials
        ? { expiresAt: new Date(credentials.expiresAt).toISOString() }
        : {}),
      ...(!config && missing.length === 0
        ? {
            error:
              "Use a valid client ID, account ID, exact HTTPS callback URL, and registered OAuth permission IDs in plugin settings.",
          }
        : {}),
      ...(config && settings.oauthCredentials && !connected
        ? {
            error:
              "Saved authorization does not match the current settings or is invalid. Connect Cloudflare again.",
          }
        : {}),
    };
  }
  connect(): Promise<{ authorizationUrl: string }> {
    return this.serialize(async () => {
      const config = binding(await this.settings());
      if (!config)
        throw new CloudflareError(
          "Set the Cloudflare OAuth client ID, account ID, exact HTTPS callback URL, and registered OAuth permissions in plugin settings.",
        );
      for (const [state, pending] of this.pending) {
        if (pending.expiresAt <= this.now()) this.pending.delete(state);
      }
      if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      this.pending.set(state, {
        binding: config,
        verifier,
        expiresAt: this.now() + STATE_TTL,
        generation: this.generation,
      });
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: config.scopes.join(" "),
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      return { authorizationUrl: url.href };
    });
  }
  callback(parameters: URLSearchParams): Promise<void> {
    // Consume state before awaiting anything, including a queued refresh or exchange.
    const states = parameters.getAll("state");
    const state = states.length === 1 ? states[0]! : "";
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt <= this.now())
      return Promise.reject(
        new CloudflareError(
          "Cloudflare login expired or has already been used. Start Connect Cloudflare again.",
        ),
      );
    return this.serialize(async () => {
      await this.assertCurrent(pending.binding, pending.generation);
      if (pending.expiresAt <= this.now())
        throw new CloudflareError("Cloudflare login expired. Start Connect Cloudflare again.");
      if (parameters.has("error"))
        throw new CloudflareError(
          "Cloudflare authorization was not approved. Start Connect Cloudflare to retry.",
        );
      const codes = parameters.getAll("code");
      if (codes.length !== 1 || !codes[0] || codes[0].length > 8192)
        throw new CloudflareError(
          "Cloudflare did not return a valid authorization code. Start Connect Cloudflare again.",
        );
      const credentials = await this.exchange(pending.binding, {
        grant_type: "authorization_code",
        code: codes[0],
        code_verifier: pending.verifier,
        redirect_uri: pending.binding.redirectUri,
      });
      await this.persistCurrent(credentials, pending.generation);
      // Completing one login invalidates other open login tabs, including queued callbacks.
      this.generation++;
      this.pending.clear();
    });
  }
  credentials(): Promise<{ token: string; accountId: string; clientId: string }> {
    const generation = this.generation;
    return this.serialize(async () => {
      const settings = await this.settings();
      const config = binding(settings);
      let credentials = readCredentials(settings.oauthCredentials);
      if (!config || !credentials || !sameBinding(config, credentials))
        throw new CloudflareError(reconnect);
      await this.assertCurrent(config, generation);
      if (credentials.expiresAt <= this.now() + REFRESH_MARGIN) {
        try {
          credentials = await this.exchange(
            config,
            { grant_type: "refresh_token", refresh_token: credentials.refreshToken },
            credentials.refreshToken,
          );
        } catch (error) {
          if (error instanceof InvalidGrantError) {
            await this.assertCurrent(config, generation, settings.oauthCredentials);
            await this.save(null);
          }
          throw error;
        }
        await this.persistCurrent(credentials, generation, settings.oauthCredentials);
      }
      await this.assertCurrent(config, generation);
      return {
        token: credentials.accessToken,
        accountId: credentials.accountId,
        clientId: credentials.clientId,
      };
    });
  }
  disconnect(): Promise<{ ok: true; message: string }> {
    this.generation++;
    this.pending.clear();
    return this.serialize(async () => {
      const credentials = readCredentials((await this.settings()).oauthCredentials);
      await this.save(null);
      const revoked = !credentials || (await this.revoke(credentials));
      return {
        ok: true,
        message: revoked
          ? "Cloudflare disconnected."
          : "Cloudflare disconnected locally. Remote token revocation could not be confirmed. Revoke the BB grant in Cloudflare Authorized Apps if needed.",
      };
    });
  }
  private async assertCurrent(config: Binding, generation: number, expectedCredentials?: string) {
    const settings = await this.settings();
    const current = binding(settings);
    if (
      this.closing ||
      generation !== this.generation ||
      !current ||
      !sameBinding(config, current) ||
      (expectedCredentials !== undefined && expectedCredentials !== settings.oauthCredentials)
    )
      throw new CloudflareError(
        "Cloudflare OAuth settings or connection changed. Start Connect Cloudflare again.",
      );
  }
  private async persistCurrent(
    credentials: Credentials,
    generation: number,
    expectedCredentials?: string,
  ) {
    try {
      await this.assertCurrent(credentials, generation, expectedCredentials);
      await this.save(credentials);
    } catch (error) {
      await this.revoke(credentials);
      throw error;
    }
  }
  private async exchange(
    config: Binding,
    parameters: Record<string, string>,
    previousRefreshToken?: string,
  ): Promise<Credentials> {
    let response: Response;
    try {
      response = await this.fetcher(TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ ...parameters, client_id: config.clientId }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new CloudflareError(
        "Cloudflare OAuth could not be reached. Retry connecting if authorization has expired.",
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new CloudflareError("Cloudflare returned an invalid OAuth response. Retry connecting.");
    }
    if (!response.ok) {
      if (z.object({ error: z.literal("invalid_grant") }).safeParse(data).success)
        throw new InvalidGrantError();
      throw new CloudflareError(
        "Cloudflare rejected the OAuth request. Check the client configuration and reconnect.",
      );
    }
    const parsed = tokenSchema.safeParse(data);
    if (!parsed.success || !(parsed.data.refresh_token || previousRefreshToken))
      throw new CloudflareError(
        "Cloudflare did not return usable offline authorization. Connect Cloudflare again.",
      );
    const credentials: Credentials = {
      ...config,
      version: 1,
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? previousRefreshToken!,
      expiresAt: this.now() + parsed.data.expires_in * 1000,
    };
    if (parsed.data.scope !== undefined) {
      const granted = new Set(parsed.data.scope.split(/\s+/));
      if (config.scopes.some((scope) => !granted.has(scope))) {
        await this.revoke(credentials);
        throw new InvalidGrantError();
      }
    }
    return credentials;
  }
  private async revoke(credentials: Credentials): Promise<boolean> {
    try {
      const response = await this.fetcher(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          token: credentials.refreshToken,
          token_type_hint: "refresh_token",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
class InvalidGrantError extends CloudflareError {
  constructor() {
    super(reconnect);
  }
}

export function oauthCallbackResponse(ok: boolean): Response {
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
  };
  const returnPath = "/plugins/cloudflare/cloudflare";
  if (ok) return new Response(null, { status: 303, headers: { ...headers, Location: returnPath } });
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cloudflare connection failed</title><body><main><h1>Cloudflare connection failed</h1><p>The login expired, was declined, or could not be completed. Return to BB and select Connect Cloudflare again.</p><p><a href="${returnPath}">Return to Cloudflare in BB</a></p></main></body></html>`,
    { status: 400, headers },
  );
}
