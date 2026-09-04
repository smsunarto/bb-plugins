export interface SessionRecord {
  sessionId: string;
  userId: string;
  refreshToken: string;
  rotations: number;
}

export interface Session {
  sessionId: string;
  userId: string;
  accessToken: string;
  expiresAt: number;
}

/** How long a minted access token stays usable. */
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

/** A session this close to its deadline is rotated on the next lookup. */
const REFRESH_WINDOW_MS = 60 * 1000;

/** How long a finished rotation stays shareable before the next one may run. */
const REFRESH_HOLD_MS = 5000;

/** Round trip to the identity provider, held to the median we see in staging. */
const PROVIDER_LATENCY_MS = 40;

const records = new Map<string, SessionRecord>();
const sessions = new Map<string, Session>();
const pendingRefreshes = new Map<string, Promise<Session>>();

export class UnknownSessionError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`no session record for ${sessionId}`);
    this.name = "UnknownSessionError";
    this.sessionId = sessionId;
  }
}

export function registerSession(record: SessionRecord): void {
  records.set(record.sessionId, record);
}

export function knownSessionIds(): string[] {
  return [...records.keys()];
}

export function isExpiring(session: Session, now: number = Date.now()): boolean {
  return session.expiresAt - now <= REFRESH_WINDOW_MS;
}

/**
 * Trades the stored refresh token for a new access token.
 *
 * The provider invalidates the old refresh token the moment it hands back a new
 * one, so the stored record has to move with it. Two rotations in a row for the
 * same session therefore leave the first access token unusable.
 */
async function rotate(sessionId: string): Promise<Session> {
  const stored = records.get(sessionId);
  if (!stored) throw new UnknownSessionError(sessionId);

  await Bun.sleep(PROVIDER_LATENCY_MS);

  // The provider counts from the refresh token that is stored when it answers,
  // not from the one we held when the call went out, so the record is read
  // again here rather than reused.
  const current = records.get(sessionId) ?? stored;
  const rotations = current.rotations + 1;
  records.set(sessionId, {
    ...current,
    refreshToken: `rt_${sessionId}_${rotations}`,
    rotations,
  });

  return {
    sessionId,
    userId: current.userId,
    accessToken: `at_${sessionId}_${rotations}`,
    expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
  };
}

export async function refreshSession(sessionId: string): Promise<Session> {
  const inFlight = pendingRefreshes.get(sessionId);
  if (inFlight) return inFlight;

  const session = await rotate(sessionId);

  // Hold the result so a burst of requests for one session reuses a single
  // round trip instead of rotating the refresh token once per request.
  const shared = Promise.resolve(session);
  pendingRefreshes.set(sessionId, shared);
  sessions.set(sessionId, session);

  const release = setTimeout(() => {
    pendingRefreshes.delete(sessionId);
  }, REFRESH_HOLD_MS);
  release.unref?.();

  return session;
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const cached = sessions.get(sessionId);
  if (cached && !isExpiring(cached)) return cached;

  try {
    return await refreshSession(sessionId);
  } catch (error) {
    if (error instanceof UnknownSessionError) return null;
    throw error;
  }
}

export function forgetSession(sessionId: string): void {
  sessions.delete(sessionId);
  pendingRefreshes.delete(sessionId);
}
