import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const desktopSessionSchema = z
  .object({
    cookie: z
      .object({
        domain: z.string().regex(/^\.?[a-z0-9.-]+$/iu),
        expiresAt: z.number().int().positive(),
        name: z.string().regex(/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu),
        value: z.string().regex(/^[a-z0-9._~-]+$/iu),
      })
      .strict(),
  })
  .strict();

type DesktopSession = z.infer<typeof desktopSessionSchema>;

export type RemoteSessionRequest = {
  forwardedHost?: string;
  gateAuth?: string;
  host?: string;
  requestUrl: string;
};

function json(body: object, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function hostnameFrom(request: RemoteSessionRequest): string | null {
  const authority = request.forwardedHost ?? request.host;
  if (authority !== undefined) {
    try {
      return new URL(`https://${authority}`).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  try {
    return new URL(request.requestUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function cookieDomainCoversHost(domain: string, hostname: string): boolean {
  const normalized = domain.replace(/^\./u, "").toLowerCase();
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

export function serializeRemoteSessionCookie(
  cookie: DesktopSession["cookie"],
  now: number = Date.now(),
): string {
  const maxAgeSeconds = Math.max(0, Math.floor((cookie.expiresAt - now) / 1000));
  return [
    `${cookie.name}=${cookie.value}`,
    `Domain=${cookie.domain}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    `Expires=${new Date(cookie.expiresAt).toUTCString()}`,
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

export async function createRemoteSessionResponse(
  bb: BbPluginApi,
  request: RemoteSessionRequest,
): Promise<Response> {
  let session: DesktopSession;
  try {
    session = await bb.sdk.plugins.callRpc({
      pluginId: "connect",
      method: "createDesktopSession",
      input: null,
      outputSchema: desktopSessionSchema,
    });
  } catch {
    return json({ ok: false, reason: "browser-login-required" }, 503);
  }

  const hostname = hostnameFrom(request);
  const isAuthenticatedConnectRequest = request.gateAuth === "session";
  if (
    !isAuthenticatedConnectRequest &&
    (hostname === null || !cookieDomainCoversHost(session.cookie.domain, hostname))
  ) {
    return json({ ok: false, reason: "browser-login-required" }, 409);
  }

  return json({ ok: true, expiresAt: session.cookie.expiresAt }, 200, {
    "set-cookie": serializeRemoteSessionCookie(session.cookie),
  });
}
