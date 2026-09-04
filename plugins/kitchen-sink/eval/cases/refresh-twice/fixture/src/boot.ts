import { type AuthContext, requireSession } from "./middleware.ts";
import { knownSessionIds, refreshSession, registerSession, type SessionRecord } from "./session.ts";

const SEED_RECORDS: SessionRecord[] = [
  {
    sessionId: "s_operations",
    userId: "u_operations",
    refreshToken: "rt_s_operations_0",
    rotations: 0,
  },
  {
    sessionId: "s_reporting",
    userId: "u_reporting",
    refreshToken: "rt_s_reporting_0",
    rotations: 0,
  },
];

export interface App {
  handle: (request: Request) => Promise<Response>;
}

export function bootstrap(): App {
  for (const record of SEED_RECORDS) registerSession(record);

  warmSessions(knownSessionIds());

  return { handle: requireSession(whoami) };
}

/**
 * Rotates every known session before traffic arrives, so the first request of
 * the day does not pay for the provider round trip.
 */
function warmSessions(sessionIds: string[]): void {
  for (const sessionId of sessionIds) {
    void refreshSession(sessionId).catch((error: unknown) => {
      console.warn(`could not warm ${sessionId}:`, error);
    });
  }
}

function whoami(context: AuthContext): Response {
  return Response.json({
    userId: context.session.userId,
    accessToken: context.session.accessToken,
    expiresAt: context.session.expiresAt,
  });
}

if (import.meta.main) {
  const app = bootstrap();
  const port = Number(Bun.env.PORT ?? 3000);

  Bun.serve({ port, fetch: (request) => app.handle(request) });
  console.log(`auth-middleware listening on :${port}`);
}
