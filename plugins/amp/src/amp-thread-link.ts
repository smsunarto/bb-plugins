import { execFile } from "node:child_process";
import {
  isValidAmpThreadId,
  isValidProviderSessionId,
  type OrbUsageRecord,
} from "./orb-usage.ts";
import type { AmpExecutionTarget } from "./execution-target.ts";

export const AMP_THREAD_LINK_KEY_PREFIX = "amp-thread-link:";

export function ampThreadLinkKey(threadId: string): string {
  return `${AMP_THREAD_LINK_KEY_PREFIX}${threadId}`;
}

export interface AmpThreadLinkRecord {
  providerSessionId: string;
  ampThreadId: string | null;
}

/** One bridge report, projected into the durable thread link and Orb UI state. */
export interface SessionLinkReport extends AmpThreadLinkRecord {
  usage: OrbUsageRecord;
}

export function buildSessionLinkCommandArgs(report: {
  sessionId: string;
  executionTarget: AmpExecutionTarget;
  ampThreadId: string | null;
}): string[] {
  return [
    "amp",
    "link-session",
    report.sessionId,
    report.executionTarget,
    ...(report.ampThreadId ? [report.ampThreadId] : []),
  ];
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

export function parseAmpThreadLinkRecord(value: unknown): AmpThreadLinkRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["providerSessionId", "ampThreadId"])) return null;
  if (!isValidProviderSessionId(record.providerSessionId)) return null;
  if (record.ampThreadId !== null && !isValidAmpThreadId(record.ampThreadId)) return null;
  return {
    providerSessionId: record.providerSessionId,
    ampThreadId: record.ampThreadId,
  };
}

/** Parse the private `bb amp link-session` wire format used by the ACP bridge. */
export function parseSessionLinkReport(argv: string[]): SessionLinkReport | null {
  const [command, providerSessionId, executionTarget, ampThreadId, ...extra] = argv;
  if (
    command !== "link-session"
    || extra.length > 0
    || !isValidProviderSessionId(providerSessionId)
    || (ampThreadId !== undefined && !isValidAmpThreadId(ampThreadId))
  ) {
    return null;
  }

  if (executionTarget === "local") {
    return {
      providerSessionId,
      ampThreadId: ampThreadId ?? null,
      usage: { providerSessionId, state: "local" },
    };
  }
  if (executionTarget !== "orb") return null;
  return ampThreadId === undefined
    ? {
        providerSessionId,
        ampThreadId: null,
        usage: { providerSessionId, state: "orb-starting" },
      }
    : {
        providerSessionId,
        ampThreadId,
        usage: { providerSessionId, state: "orb-active", ampThreadId },
      };
}

/** A provider session owns one Amp thread. Late starting reports cannot erase it. */
export function mergeAmpThreadLinkRecord(
  current: AmpThreadLinkRecord | null,
  incoming: AmpThreadLinkRecord,
): AmpThreadLinkRecord {
  if (
    current?.providerSessionId === incoming.providerSessionId
    && current.ampThreadId !== null
  ) {
    return current;
  }
  return {
    providerSessionId: incoming.providerSessionId,
    ampThreadId: incoming.ampThreadId,
  };
}

/** Select only a link that belongs to bb's current provider session. */
export function currentAmpThreadId(
  providerSessionId: string,
  link: AmpThreadLinkRecord | null,
  usage: OrbUsageRecord | null,
): string | null {
  if (link?.providerSessionId === providerSessionId && link.ampThreadId !== null) {
    return link.ampThreadId;
  }
  if (usage?.providerSessionId === providerSessionId && usage.state === "orb-active") {
    return usage.ampThreadId;
  }
  return null;
}

/** Archive an existing Amp thread without starting or continuing an agent turn. */
export function archiveAmpThread(
  ampCli: string,
  ampThreadId: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isValidAmpThreadId(ampThreadId)) {
    return Promise.reject(new Error(`Invalid Amp thread id: ${ampThreadId}`));
  }

  const env: NodeJS.ProcessEnv = { ...sourceEnv, CI: "1", TERM: "dumb" };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    execFile(
      ampCli,
      ["threads", "archive", ampThreadId],
      {
        encoding: "utf8",
        env,
        maxBuffer: 64 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = stderr.trim() || stdout.trim() || error.message;
        reject(new Error(`Could not archive Amp thread ${ampThreadId}: ${detail}`, {
          cause: error,
        }));
      },
    );
  });
}
