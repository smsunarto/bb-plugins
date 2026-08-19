export const MAX_PROVIDER_SESSION_ID_LENGTH = 256;
export const MAX_AMP_THREAD_ID_LENGTH = 128;
export const ORB_USAGE_CHANNEL = "orb-usage";
export const ORB_USAGE_KEY_PREFIX = "orb-usage:";

export function orbUsageKey(threadId: string): string {
  return `${ORB_USAGE_KEY_PREFIX}${threadId}`;
}

export interface ProviderIdentityCursor {
  providerSessionId: string;
  seq: number;
}

export type NextProviderIdentity = (
  afterSeq: string | undefined,
) => Promise<ProviderIdentityCursor | null>;

export async function findLatestProviderSessionId(
  nextIdentity: NextProviderIdentity,
): Promise<string | null> {
  let afterSeq: string | undefined;
  let latest: string | null = null;
  for (;;) {
    const identity = await nextIdentity(afterSeq);
    if (identity === null) return latest;
    if (
      !Number.isSafeInteger(identity.seq) ||
      identity.seq < 0 ||
      (afterSeq !== undefined && identity.seq <= Number(afterSeq)) ||
      !isValidProviderSessionId(identity.providerSessionId)
    ) {
      return null;
    }
    latest = identity.providerSessionId;
    afterSeq = String(identity.seq);
  }
}

export type OrbUsageRecord =
  | Readonly<{
      providerSessionId: string;
      state: "local";
    }>
  | Readonly<{
      providerSessionId: string;
      state: "orb-starting";
    }>
  | Readonly<{
      providerSessionId: string;
      state: "orb-active";
      ampThreadId: string;
    }>;

export type OrbUsageView =
  | Readonly<{ state: "hidden" }>
  | Readonly<{ state: "starting" }>
  | Readonly<{
      state: "active";
      ampThreadId: string;
      syncCommand: string;
    }>;

function matchesExactly(value: string, pattern: RegExp): boolean {
  return pattern.exec(value)?.[0] === value;
}

export function isValidProviderSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROVIDER_SESSION_ID_LENGTH &&
    matchesExactly(value, /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u)
  );
}

export function isValidAmpThreadId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 2 &&
    value.length <= MAX_AMP_THREAD_ID_LENGTH &&
    matchesExactly(value, /^T-[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

export function parseOrbUsageRecord(value: unknown): OrbUsageRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (!isValidProviderSessionId(record.providerSessionId)) return null;

  if (record.state === "local" || record.state === "orb-starting") {
    if (!hasExactKeys(record, ["providerSessionId", "state"])) return null;
    return {
      providerSessionId: record.providerSessionId,
      state: record.state,
    };
  }

  if (record.state === "orb-active") {
    if (!hasExactKeys(record, ["providerSessionId", "state", "ampThreadId"])) return null;
    if (!isValidAmpThreadId(record.ampThreadId)) return null;
    return {
      providerSessionId: record.providerSessionId,
      state: record.state,
      ampThreadId: record.ampThreadId,
    };
  }

  return null;
}

export function mergeOrbUsageRecord(
  current: OrbUsageRecord | null,
  incoming: OrbUsageRecord,
): OrbUsageRecord {
  if (
    current?.providerSessionId === incoming.providerSessionId &&
    current.state === "orb-active" &&
    incoming.state === "orb-starting"
  ) {
    return current;
  }

  return incoming;
}

export function toOrbUsageView(record: OrbUsageRecord | null): OrbUsageView {
  if (record === null || record.state === "local") return { state: "hidden" };
  if (record.state === "orb-starting") return { state: "starting" };

  return {
    state: "active",
    ampThreadId: record.ampThreadId,
    syncCommand: `amp sync ${record.ampThreadId}`,
  };
}
