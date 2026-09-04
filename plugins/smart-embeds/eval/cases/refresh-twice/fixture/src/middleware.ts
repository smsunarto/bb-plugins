import { getSession, type Session } from "./session.ts";

export interface AuthContext {
  request: Request;
  session: Session;
}

export type Handler = (context: AuthContext) => Response | Promise<Response>;

export interface AuthOptions {
  headerName?: string;
  cookieName?: string;
}

const DEFAULT_HEADER = "x-session-id";
const DEFAULT_COOKIE = "sid";

export function readSessionId(request: Request, options: AuthOptions = {}): string | null {
  const fromHeader = request.headers.get(options.headerName ?? DEFAULT_HEADER);
  if (fromHeader) return fromHeader.trim();

  const cookie = request.headers.get("cookie");
  if (!cookie) return null;

  const wanted = options.cookieName ?? DEFAULT_COOKIE;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== wanted) continue;
    const raw = part.slice(separator + 1).trim();
    return raw.length > 0 ? decodeURIComponent(raw) : null;
  }

  return null;
}

/**
 * Wraps a handler so it only runs with a resolved session. A session the store
 * does not know about is a 401, not a 500: expired records are pruned on their
 * own schedule and clients keep sending the cookie for a while afterwards.
 */
export function requireSession(handler: Handler, options: AuthOptions = {}) {
  return async function authenticate(request: Request): Promise<Response> {
    const sessionId = readSessionId(request, options);
    if (!sessionId) return unauthorized("missing session id");

    const session = await getSession(sessionId);
    if (!session) return unauthorized("unknown session");

    const response = await handler({ request, session });
    response.headers.set("x-session-user", session.userId);
    return response;
  };
}

function unauthorized(reason: string): Response {
  return Response.json({ error: reason }, { status: 401 });
}
